import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boot, BUILD_OK, until, useCloneSandbox } from "./clone-test-kit.js";
import { LOCAL_PLAN, PROGRESS, productionStatus, released, templateStatus } from "./build-test-kit.js";

/**
 * 一次出片的执行过程（REQ-006 出片、REQ-009 台账、AC-020 的 mp4 部分）：提交 → status --watch → get。
 * 成败只看 result、失败原文与上下文、receipt、导出、各步的取消与出错。
 */

useCloneSandbox();

describe("成败只看 result.outcome", () => {
  it("work.state 是 done 但 result 是 failed：标失败，failure 原文完整落库，记下可用内存与最后一条进度，模板不进验货", async () => {
    const b = await boot();
    const failure =
      "Command need:…:request-visual-render ended without a stored result: Endpoint hyperframes.local failed render-visual: Rendered visual frame rate differs from its document\n[hyperframes] browserGpuMode probe … ; caused by: Rendered visual frame rate differs from its document";
    b.setBuild({
      lines: PROGRESS,
      json: {
        format: "hypit.cli-build@1",
        build: {
          id: "bld_fail",
          targets: ["reference.video"],
          failure,
          work: { state: "done", outcome: "failed" },
          result: { state: "failed", outputCount: 74 },
        },
      },
    });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "出片失败");
    const build = b.build.latestBuild(id);
    expect(build).toMatchObject({
      status: "failed",
      errorCode: "BUILD_FAILED",
      errorMessage: failure,
      hypitBuildId: "bld_fail",
    });
    expect(build?.context?.freeMemBytes).toBeGreaterThan(0);
    expect(build?.context?.lastProgress).toBe("· Saving Result · 1/3 steps complete · 8m 21s");
    expect(b.hypitCalls.some((c) => c[0] === "get")).toBe(false);
    expect(templateStatus(b)).toBe("cloning");
  });

  it("提交成功但跟进度的进程炸了 / 超时：先让 hypit 取消这条 build，再记失败并留原文", async () => {
    const b = await boot();
    const { HypitError } = await import("../hypit/cli.js");
    b.setWatch(new HypitError("TIMEOUT", "hypit status … 超过 10800s 未返回", undefined, ""));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "出片失败");
    expect(b.build.latestBuild(id)).toMatchObject({ errorCode: "TIMEOUT", hypitBuildId: "bld_test_0001" });
    // Worker 上那条 build 可能还在跑：必须被取消，不能只在宿主这边记失败
    expect(b.cancelled).toEqual(["bld_test_0001"]);
  });

  it("build 进程本身起不来（HypitError）：失败并留原文", async () => {
    const b = await boot();
    const { HypitError } = await import("../hypit/cli.js");
    b.setBuild(new HypitError("RUNTIME_DOWN", "Worker is not running", "hypit runtime up", "stderr 原文"));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "出片失败");
    expect(b.build.latestBuild(id)).toMatchObject({
      errorCode: "RUNTIME_DOWN",
      errorMessage: "Worker is not running\nhypit runtime up\nstderr 原文",
    });
  });

  it("get 导出后文件不在：算失败，不能把没有 mp4 的出片记成完成", async () => {
    const b = await boot();
    b.setGet(() => ({
      format: "hypit.cli-get@1",
      kind: "resource",
      path: path.join(b.workspace, "output", "nothing.mp4"),
    }));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "出片失败");
    expect(b.build.latestBuild(id)?.errorCode).toBe("OUTPUT_MISSING");
  });

  it("composite 导出：目录里 files/ 下的 mp4 才是成片", async () => {
    const b = await boot();
    b.setGet((to) => {
      const dir = `${to}.dir`;
      mkdirSync(path.join(dir, "files"), { recursive: true });
      writeFileSync(path.join(dir, "files", "file-0002.mp4"), "fake", "utf8");
      return { format: "hypit.cli-get@1", kind: "composite", path: dir };
    });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "done", "出片完成");
    expect(b.build.latestBuild(id)?.outputPath).toMatch(/file-0002\.mp4$/);
  });
});

describe("出片前的准备", () => {
  it("出片前重写 Runtime Profile（Agent 改过的路由被覆盖）", async () => {
    const b = await boot();
    const profile = path.join(b.workspace, "hypit.runtime.json");
    const corrupt = () => writeFileSync(profile, JSON.stringify({ endpoints: { evil: {} } }), "utf8");
    // 估价那次重写之后、出片之前 profile 又被改了（plan 一跑完就改）：出片前必须再重写一次，不能只靠估价那次
    b.setPlan(async () => {
      corrupt();
      return LOCAL_PLAN;
    });
    b.setBuild(() => {
      // build 开跑那一刻读到的 profile 必须是宿主重写过的
      const written = JSON.parse(readFileSync(profile, "utf8")) as { endpoints: Record<string, unknown> };
      expect(written.endpoints["hyperframes.local"]).toBeDefined();
      expect(written.endpoints.evil).toBeUndefined();
      return { lines: [], json: BUILD_OK };
    });
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    corrupt();
    await b.finishRun();
    const replica = b.clone.latestReplica(b.templateId) as { id: string };
    await until(() => productionStatus(b, replica.id) === "done", "出片完成");
  });
});

describe("receipt 与各步出错", () => {
  it("--verbose 跟到底：完成了的远程操作带 receipt，台账记第一条带 url 的（REQ-009）", async () => {
    const b = await boot();
    b.setBuild({
      lines: [],
      json: {
        ...BUILD_OK,
        build: {
          ...BUILD_OK.build,
          operations: [
            { endpoint: "hyperframes.local", status: "completed" },
            { endpoint: "tokendance.default", status: "completed", receipt: { id: "rcpt_no_url" } },
            {
              endpoint: "tokendance.default",
              status: "completed",
              receipt: { id: "rcpt_1", url: "https://tokendance.space/receipts/1" },
            },
          ],
        },
      },
    });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "done", "出片完成");
    expect(b.build.latestBuild(id)).toMatchObject({
      receiptId: "rcpt_1",
      receiptUrl: "https://tokendance.space/receipts/1",
    });
    // 不带 --verbose 的话 hypit 会把完成了的操作连 receipt 一起过滤掉
    expect(b.hypitCalls.find((c) => c[0] === "status")).toContain("--verbose");
  });

  it("hypit 自己报 cancelled（别处取消了它）：build 记 cancelled，出片单位回到 failed 可重试", async () => {
    const b = await boot();
    b.setBuild({
      lines: [],
      json: { ...BUILD_OK, build: { ...BUILD_OK.build, failure: "Build cancelled", result: { state: "cancelled" } } },
    });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "回到失败");
    expect(b.build.latestBuild(id)).toMatchObject({
      status: "cancelled",
      errorCode: "CANCELLED",
      errorMessage: "Build cancelled",
    });
    expect(b.hypitCalls.some((c) => c[0] === "get")).toBe(false);
  });

  it("提交没报出 build id：BUILD_NO_ID，不去跟也不去导出", async () => {
    const b = await boot();
    b.setSubmit({ format: "hypit.cli-build@1", build: { targets: ["reference.video"] } });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "出片失败");
    expect(b.build.latestBuild(id)?.errorCode).toBe("BUILD_NO_ID");
    expect(b.hypitCalls.some((c) => c[0] === "status" || c[0] === "get")).toBe(false);
  });

  it("成功但没报出目标名：BUILD_NO_TARGET", async () => {
    const b = await boot();
    b.setBuild({ lines: [], json: { ...BUILD_OK, build: { ...BUILD_OK.build, targets: [] } } });
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "出片失败");
    expect(b.build.latestBuild(id)?.errorCode).toBe("BUILD_NO_TARGET");
  });

  it("get 本身失败：GET_FAILED 并留原文", async () => {
    const b = await boot();
    b.setGet(new Error("导出炸了"));
    const id = await released(b);
    await until(() => productionStatus(b, id) === "failed", "出片失败");
    expect(b.build.latestBuild(id)).toMatchObject({ errorCode: "GET_FAILED", errorMessage: "Error: 导出炸了" });
  });
});
