import { describe, expect, it } from "vitest";
import { boot, until, useCloneSandbox } from "./clone-test-kit.js";
import { LOCAL_PLAN, productionStatus, released } from "./build-test-kit.js";

/**
 * 一次出片的执行过程（REQ-006 出片、REQ-009 台账、AC-020 的 mp4 部分）：提交 → status --watch → get。
 * 这里是各步的取消与孤儿 build 的处理；成败判定、receipt、导出在 build-execute.test.ts。
 */

useCloneSandbox();

describe("取消与孤儿 build", () => {
  it("导出时取消：get 被中止，记已取消", async () => {
    const b = await boot();
    let getStarted = () => undefined as void;
    const started = new Promise<void>((r) => (getStarted = r));
    b.setGet((_to, options) => {
      getStarted();
      return new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const id = await released(b);
    await started;
    await b.build.cancelBuild(id);
    await until(() => productionStatus(b, id) === "failed", "回到失败（可重试）");
    expect(b.build.latestBuild(id)).toMatchObject({ status: "cancelled", errorMessage: "已取消出片（导出时）" });
  });

  it("提交期间取消：提交不被打断（打断了就拿不到 id），返回后先让 hypit 取消再记已取消", async () => {
    const b = await boot();
    let finishSubmit: (v: Record<string, unknown>) => void = () => undefined;
    let submitSeen = () => undefined as void;
    const seen = new Promise<void>((r) => (submitSeen = r));
    b.setSubmit((options) => {
      submitSeen();
      expect(options.signal).toBeUndefined();
      return new Promise((resolve) => (finishSubmit = resolve));
    });
    const id = await released(b);
    await seen;
    const view = await b.build.cancelBuild(id);
    expect(view.hypitBuildId).toBeNull();
    expect(b.cancelled).toEqual([]);
    finishSubmit({ format: "hypit.cli-build@1", build: { id: "bld_late", targets: ["reference.video"] } });
    await until(() => productionStatus(b, id) === "failed", "回到失败（可重试）");
    expect(b.cancelled).toEqual(["bld_late"]);
    expect(b.build.latestBuild(id)).toMatchObject({ status: "cancelled", hypitBuildId: "bld_late" });
    expect(b.hypitCalls.some((c) => c[0] === "status")).toBe(false);
  });

  it("提交超时 / 炸了：activity 帧里唯一活跃的 build 当作它，取消掉再记失败", async () => {
    const b = await boot();
    const { HypitError } = await import("../hypit/cli.js");
    b.setSubmit(() => {
      b.watcher.push(
        JSON.stringify({
          format: "hypit.cli-activity@1",
          at: 1,
          worker: "running",
          builds: [{ id: "bld_orphan", work: { state: "working" }, phases: {} }],
        }),
      );
      return new HypitError("TIMEOUT", "hypit build … 超过 600s 未返回", undefined, "");
    });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "出片失败");
    expect(b.build.latestBuild(id)?.errorCode).toBe("TIMEOUT");
    expect(b.cancelled).toEqual(["bld_orphan"]);
  });

  it("status 以「需要处理」退出（result 缺失）：attention 的原文当失败原因，并让 hypit 取消那条 build", async () => {
    const b = await boot();
    b.setBuild({
      lines: [],
      json: {
        format: "hypit.cli-status@1",
        build: {
          id: "bld_test_0001",
          targets: ["reference.video"],
          attention: { message: "Endpoint hyperframes.local is not reachable" },
          result: { state: "missing" },
        },
      },
    });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "出片失败");
    expect(b.build.latestBuild(id)).toMatchObject({
      errorCode: "BUILD_FAILED",
      errorMessage: "Endpoint hyperframes.local is not reachable",
    });
    expect(b.cancelled).toEqual(["bld_test_0001"]);
  });

  it("提交炸了时猜孤儿：activity 帧里同目录别的 build（已知 id）要排除，别把它取消了", async () => {
    const b = await boot();
    b.db().prepare("UPDATE settings SET render_concurrency = 2 WHERE id = 1").run();
    const { HypitError } = await import("../hypit/cli.js");
    // 第一条：提交成功、跟进度时挂住（id bld_test_0001 已在台账）
    let submits = 0;
    b.setBuild(() => new Promise(() => undefined));
    b.setSubmit(() => {
      submits += 1;
      if (submits === 1) {
        return { format: "hypit.cli-build@1", build: { id: "bld_test_0001", targets: ["reference.video"] } };
      }
      // 第二条：提交炸了，而帧里只有第一条那个 build
      b.watcher.push(
        JSON.stringify({
          format: "hypit.cli-activity@1",
          at: 1,
          worker: "running",
          builds: [{ id: "bld_test_0001", work: { state: "working" }, phases: {} }],
        }),
      );
      return new HypitError("TIMEOUT", "hypit build … 超过 600s 未返回", undefined, "");
    });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "building", "第一条在跑");
    const now = new Date().toISOString();
    b.db()
      .prepare(
        `INSERT INTO productions (id, template_id, kind, version, run_path, status, created_at, updated_at)
         VALUES ('p2', ?, 'replica', 2, 'reference.svrun', 'queued', ?, ?)`,
      )
      .run(b.templateId, now, now);
    b.setPlan(LOCAL_PLAN);
    await b.estimate.estimateProduction("p2");
    await until(() => productionStatus(b, "p2") === "failed", "第二条失败");
    expect(b.build.latestBuild("p2")?.errorCode).toBe("TIMEOUT");
    // 帧里唯一那条是第一条的，不是孤儿：不能取消
    expect(b.cancelled).toEqual([]);
    expect(productionStatus(b, id)).toBe("building");
  });
});
