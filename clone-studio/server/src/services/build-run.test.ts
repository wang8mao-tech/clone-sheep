import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boot, BUILD_OK, until, uploadFile, useCloneSandbox } from "./clone-test-kit.js";
import { LOCAL_PLAN, PROGRESS, productionStatus, released, templateStatus } from "./build-test-kit.js";

/**
 * 出片执行器的队列一侧（REQ-006 出片、AC-017 / 018）：放行、并发、取消、重试、删除、重启。
 * hypit 的 build / status / get / cancel 是假的，形状照 09-23 实跑；库、文件、Runtime Profile 是真的。
 * 一次出片的成败判定、导出、receipt 在 build-execute.test.ts。
 */

useCloneSandbox();

describe("限额内自动出片（AC-017）", () => {
  it("估价 auto 之后执行器自己起片：build --json 提交拿 id，status --watch --json 跟到结束，成功后 get 导出到 output/，台账落库，模板进入验货", async () => {
    const b = await boot();
    (await import("../lib/secrets.js")).setSecret("tokendance.apiKey", "td-test-key");
    b.setBuild({ lines: PROGRESS, json: BUILD_OK });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "done", "出片完成");

    const build = b.build.latestBuild(id);
    expect(build).toMatchObject({ status: "done", hypitBuildId: "bld_test_0001", estimateUsd: 0, errorMessage: null });
    expect(build?.outputPath).toMatch(/[\\/]output[\\/]replica-v1-[0-9a-f]{8}\.mp4$/);
    expect(existsSync(build?.outputPath as string)).toBe(true);
    const buildCall = b.hypitCalls.find((c) => c[0] === "build") as string[];
    expect(buildCall).toEqual([
      "build",
      "reference.svrun",
      "--runtime",
      "hypit.runtime.json",
      "--workspace",
      b.workspace,
      "--json",
    ]);
    // 提交后立刻跟：id 来自提交那步的 JSON
    const statusCall = b.hypitCalls.find((c) => c[0] === "status") as string[];
    expect(statusCall).toEqual([
      "status",
      "bld_test_0001",
      "--workspace",
      b.workspace,
      "--watch",
      "--json",
      "--verbose",
    ]);
    const getCall = b.hypitCalls.find((c) => c[0] === "get") as string[];
    expect(getCall.slice(0, 4)).toEqual(["get", "bld_test_0001", "--output", "reference.video"]);
    // key 只进 hypit 子进程：build / get 都带上凭据环境（设置里存了什么给什么），宿主进程环境不动
    const buildOptions = b.hypitOptions[b.hypitCalls.findIndex((c) => c[0] === "build")];
    expect(buildOptions?.env).toEqual({ TOKENDANCE_API_KEY: "td-test-key" });
    expect(process.env.TOKENDANCE_API_KEY).toBeUndefined();
    // 复刻片出完：模板进 ③ 验货
    expect(templateStatus(b)).toBe("awaiting_review");
  });

  it("待确认花费的不会自动起片；人确认后才起（AC-018）", async () => {
    const b = await boot();
    b.rates.upsertRate({ capability: "@hypit/render-hyperframes@1#render-visual", unit: "second", usd: 0.1 });
    const id = await released(b);
    // 30 秒 × $0.1 = $3 > 单条限额 $1.5
    expect(productionStatus(b, id)).toBe("awaiting_cost_confirm");
    await new Promise((r) => setTimeout(r, 50));
    expect(b.hypitCalls.some((c) => c[0] === "build")).toBe(false);

    b.estimate.confirmCost(id);
    await until(() => productionStatus(b, id) === "done", "确认后出片完成");
    expect(b.build.latestBuild(id)).toMatchObject({ status: "done", estimateUsd: 3 });
  });
});

describe("进度、取消、重试", () => {
  it("运行中：进度行解析进 latestBuild().progress；取消后 follow 进程被中止、hypit cancel 被调用、状态已取消", async () => {
    const b = await boot();
    let release: (v: { lines: string[]; json: Record<string, unknown> } | Error) => void = () => undefined;
    b.setBuild((options) => {
      options.onStderrLine?.(PROGRESS[1] as string);
      return new Promise((resolve) => {
        release = resolve;
        options.signal?.addEventListener("abort", () => resolve(new Error("aborted")));
      });
    });
    const id = await released(b);
    await until(() => b.build.latestBuild(id)?.progress !== null, "进度到了");
    expect(b.build.latestBuild(id)?.progress).toMatchObject({
      phase: "rendering frames",
      unitsDone: 476,
      unitsTotal: 900,
    });
    expect(productionStatus(b, id)).toBe("building");

    // 提交一返回台账里就有 hypit 的 build id
    expect(b.build.latestBuild(id)?.hypitBuildId).toBe("bld_test_0001");

    await b.build.cancelBuild(id);
    // 出片单位上的「已取消」是作废的意思：人取消出片，build 记 cancelled、出片单位回到 failed，② 页还看得见、能重试
    await until(() => productionStatus(b, id) === "failed", "回到失败（可重试）");
    expect(b.build.latestBuild(id)).toMatchObject({ status: "cancelled", errorCode: "CANCELLED" });
    expect(b.cancelled).toEqual(["bld_test_0001"]);
    expect(b.clone.latestReplica(b.templateId)?.id).toBe(id);
    void release;
  });

  it("activity --watch --jsonl：有 build 在跑时开一个 watcher，帧里的阶段计数进 latestBuild().activity，跑完就停", async () => {
    const b = await boot();
    let release: (v: { lines: string[]; json: Record<string, unknown> }) => void = () => undefined;
    b.setBuild(() => new Promise((resolve) => (release = resolve)));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "building", "渲染中");
    expect(b.watcher.started).toBe(1);
    // 不是 JSON 的行跳过；帧里按提交时拿到的 build id 对自己那条
    b.watcher.push("hint: not json");
    b.watcher.push(
      JSON.stringify({
        format: "hypit.cli-activity@1",
        at: 1,
        worker: "running",
        builds: [
          {
            id: "bld_test_0001",
            work: { state: "working", requests: { total: 3, completed: 1 } },
            phases: { "rendering frames": 1 },
          },
        ],
      }),
    );
    expect(b.build.latestBuild(id)?.activity).toEqual({
      phases: { "rendering frames": 1 },
      requests: { total: 3, completed: 1 },
    });
    // 同一个 Runtime 里还有别的 build：按 id 对，只拿自己的
    b.watcher.push(
      JSON.stringify({
        format: "hypit.cli-activity@1",
        at: 2,
        worker: "running",
        builds: [
          { id: "other", work: {}, phases: { "encoding video": 1 } },
          { id: "bld_test_0001", work: {}, phases: { "rendering frames": 1 } },
        ],
      }),
    );
    expect(b.build.latestBuild(id)?.activity).toEqual({ phases: { "rendering frames": 1 }, requests: null });
    // 帧里没有自己：不拿别人的
    b.watcher.push(
      JSON.stringify({
        format: "hypit.cli-activity@1",
        at: 3,
        worker: "running",
        builds: [{ id: "other", work: {}, phases: {} }],
      }),
    );
    expect(b.build.latestBuild(id)?.activity).toBeNull();

    // watcher 进程自己退了（真机：提交前 Worker 还没起来，hypit activity 直接退出）：帧清掉、2 秒后再起一个
    b.watcher.exit();
    expect(b.build.latestBuild(id)?.activity).toBeNull();
    await until(() => b.watcher.started === 2, "watcher 重起");
    b.watcher.push(
      JSON.stringify({
        format: "hypit.cli-activity@1",
        at: 4,
        worker: "running",
        builds: [{ id: "bld_test_0001", work: {}, phases: { "encoding video": 1 } }],
      }),
    );
    expect(b.build.latestBuild(id)?.activity).toEqual({ phases: { "encoding video": 1 }, requests: null });

    release({ lines: [], json: BUILD_OK });
    await until(() => productionStatus(b, id) === "done", "出片完成");
    expect(b.watcher.stopped).toBe(1);
    expect(b.build.latestBuild(id)?.activity).toBeNull();
    // 停了之后进程再退也不会再起
    b.watcher.exit();
    await new Promise((r) => setTimeout(r, 2_300));
    expect(b.watcher.started).toBe(2);
  }, 15_000);

  it("重试出片：失败的回到排队，执行器再起一次，新 build 记录", async () => {
    const b = await boot();
    b.setBuild(new Error("第一次炸了"));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "第一次失败");
    b.setBuild({ lines: [], json: BUILD_OK });
    b.build.retryBuild(id);
    await until(() => productionStatus(b, id) === "done", "重试成功");
    expect(b.db().prepare("SELECT COUNT(*) AS n FROM builds WHERE production_id = ?").get(id)).toEqual({ n: 2 });
  });

  it("估价 blocked 的失败（没出过片）不能「重试出片」：那条要走重新估价", async () => {
    const b = await boot();
    b.setPlan({ ...LOCAL_PLAN, ok: false, unresolvedRequestCount: 1, providers: [], needs: [] });
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    await b.finishRun();
    await until(() => b.clone.latestReplica(b.templateId)?.status === "failed", "估价 blocked");
    const id = b.clone.latestReplica(b.templateId)?.id as string;
    expect(() => b.build.retryBuild(id)).toThrow(/重新估价/);
    expect(productionStatus(b, id)).toBe("failed");
  });

  it("出片进行中拒绝换参考视频（BUILD_ACTIVE）", async () => {
    const b = await boot();
    b.setBuild(
      (options) =>
        new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(new Error("aborted")))),
    );
    const id = await released(b);
    await until(() => productionStatus(b, id) === "building", "渲染中");
    await expect(
      b.evidence.startEvidence({
        templateId: b.templateId,
        source: { kind: "file", path: uploadFile() },
        language: "zh",
      }),
    ).rejects.toMatchObject({ code: "BUILD_ACTIVE" });
    await b.build.cancelBuild(id);
  });

  it("删除模板时正在跑的出片先被取消：hypit cancel 拿到 build id，本地子进程中止，之后才删目录", async () => {
    const b = await boot();
    b.setBuild(
      (options) =>
        new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(new Error("aborted")))),
    );
    const id = await released(b);
    await until(() => productionStatus(b, id) === "building", "渲染中");
    const deletion = await import("./deletion.js");
    await deletion.deleteTemplate(b.templateId);
    expect(b.cancelled).toEqual(["bld_test_0001"]);
    expect(b.db().prepare("SELECT 1 FROM templates WHERE id = ?").get(b.templateId)).toBeUndefined();
    expect(existsSync(b.workspace)).toBe(false);
  });

  it("全局渲染并发默认 1：第二条排队等第一条出完", async () => {
    const b = await boot();
    const releases: Array<() => void> = [];
    b.setBuild(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ lines: [], json: BUILD_OK }));
        }),
    );
    const id = await released(b);
    await until(() => productionStatus(b, id) === "building", "第一条在渲染");
    // 再排一条放行了的（同模板第二个复刻片版本）
    const now = new Date().toISOString();
    b.db()
      .prepare(
        `INSERT INTO productions (id, template_id, kind, version, run_path, status, created_at, updated_at)
         VALUES ('p2', ?, 'replica', 2, 'reference.svrun', 'queued', ?, ?)`,
      )
      .run(b.templateId, now, now);
    await b.estimate.estimateProduction("p2");
    await new Promise((r) => setTimeout(r, 50));
    expect(productionStatus(b, "p2")).toBe("queued");
    expect(b.hypitCalls.filter((c) => c[0] === "build")).toHaveLength(1);

    (releases.shift() as () => void)();
    await until(() => productionStatus(b, "p2") === "building", "第二条接上");
    (releases.shift() as () => void)();
    await until(() => productionStatus(b, "p2") === "done", "第二条出完");
  });

  it("重启：放行了但没起来的出片单位由 pumpBuilds 接上", async () => {
    const b = await boot({ register: false });
    b.setPlan(LOCAL_PLAN);
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    const jobId = await b.finishRun();
    await b.clone.verifyClone(b.store.requireJob(jobId));
    const replica = b.clone.latestReplica(b.templateId) as { id: string };
    await until(() => b.estimate.currentEstimate(replica.id) !== undefined, "估价落库");
    // 估价 auto 会顺手 pump；模拟「重启前没起来」：把 build 记录删掉、状态回排队
    await until(() => productionStatus(b, replica.id) !== "building", "第一次出完");
    b.db().prepare("DELETE FROM builds WHERE production_id = ?").run(replica.id);
    b.db().prepare("UPDATE productions SET status = 'queued' WHERE id = ?").run(replica.id);
    expect(b.build.pumpBuilds()).toBe(1);
    await until(() => productionStatus(b, replica.id) === "done", "重启后出完");
  });
  it("重启：上次死掉时还在跑的 build 由 markStaleRunningAsInterrupted 报出来，启动时逐条让 hypit 取消", async () => {
    const b = await boot();
    const now = new Date().toISOString();
    b.db()
      .prepare(
        `INSERT INTO productions (id, template_id, kind, version, run_path, status, created_at, updated_at)
         VALUES ('p-stale', ?, 'replica', 1, 'reference.svrun', 'building', ?, ?)`,
      )
      .run(b.templateId, now, now);
    b.db()
      .prepare(
        `INSERT INTO builds (id, production_id, hypit_build_id, estimate_usd, status, started_at, created_at)
         VALUES ('b-stale', 'p-stale', 'bld_stale', 0, 'running', ?, ?)`,
      )
      .run(now, now);
    const stale = (await import("../db/migrate.js")).markStaleRunningAsInterrupted();
    expect(stale.orphans).toEqual([{ productionId: "p-stale", hypitBuildId: "bld_stale" }]);
    expect(productionStatus(b, "p-stale")).toBe("interrupted");
    expect(await b.build.cancelOrphanedBuilds(stale.orphans)).toBe(1);
    expect(b.cancelled).toEqual(["bld_stale"]);
    // 中断的可以重试：它出过片（有 build 记录）；重试要闸门放行，给它一条 auto 结论
    b.db()
      .prepare(
        `INSERT INTO estimates (id, production_id, kind, total_usd, lines_json, decision, reasons_json, created_at)
         VALUES ('e-stale', 'p-stale', 'ok', 0, '[]', 'auto', '[]', ?)`,
      )
      .run(now);
    expect(b.build.retryBuild("p-stale").queued).toBe(true);
  });
});

describe("台账记 Codex 生图张数（REQ-011，Task 11.2）", () => {
  it("放行的估价里有 2 个走 codex.local 的 gpt-image 请求：出片记 codex_images = 2，估价仍 $0", async () => {
    const b = await boot();
    b.setBuild({ lines: PROGRESS, json: BUILD_OK });
    const gpt = (request: string) => ({
      request,
      capability: "@hypit/gpt-image@1#gpt-image-2",
      status: "resolved",
      endpoint: "codex.local",
      pricing: { kind: "local" },
    });
    b.setPlan({
      ...LOCAL_PLAN,
      providers: [...LOCAL_PLAN.providers, gpt("g1"), gpt("g2")],
      needs: [
        ...LOCAL_PLAN.needs,
        { request: "g1", summary: { fields: {} } },
        { request: "g2", summary: { fields: {} } },
      ],
    });
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    await b.finishRun();
    await until(() => b.clone.latestReplica(b.templateId) !== undefined, "复刻片建出来");
    const id = (b.clone.latestReplica(b.templateId) as { id: string }).id;
    await until(() => productionStatus(b, id) === "done", "出片完成");
    const row = b.db().prepare("SELECT codex_images, estimate_usd FROM builds WHERE production_id = ?").get(id);
    expect(row).toEqual({ codex_images: 2, estimate_usd: 0 });
  });

  it("没走 Codex：codex_images 为空", async () => {
    const b = await boot();
    b.setBuild({ lines: PROGRESS, json: BUILD_OK });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "done", "出片完成");
    expect(b.db().prepare("SELECT codex_images FROM builds WHERE production_id = ?").get(id)).toEqual({
      codex_images: null,
    });
  });

  it("codexImages：只数 endpoint 是 codex.local 的行", async () => {
    const { codexImages } = await import("./build-run.js");
    expect(
      codexImages([
        { endpoint: "codex.local", count: 3 },
        { endpoint: "tokendance.default", count: 5 },
        { endpoint: "codex.local", count: 1 },
      ]),
    ).toBe(4);
    expect(codexImages([{ endpoint: null, count: 2 }])).toBeNull();
    expect(codexImages([])).toBeNull();
  });
});
