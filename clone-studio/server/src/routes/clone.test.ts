import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { boot, until, useCloneSandbox } from "../services/clone-test-kit.js";

/** ② 复刻页的接口：GET 给文件、当前这次运行的结论与复刻片；POST 手动开始 */

useCloneSandbox();

async function app() {
  const Fastify = (await import("fastify")).default;
  const { cloneRoutes } = await import("./clone.js");
  const server = Fastify();
  await server.register(cloneRoutes);
  return server;
}

describe("GET /api/templates/:id/clone", () => {
  it("文件没产生是 null；产生了带全文、这一次的结论与复刻片", async () => {
    const b = await boot();
    const server = await app();
    const url = `/api/templates/${b.templateId}/clone`;
    expect((await server.inject({ url })).json()).toMatchObject({
      analysis: null,
      timeline: null,
      svrunExists: false,
      verdict: null,
      verifying: false,
      replica: null,
    });

    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    await b.finishRun();
    await until(() => b.verdictCount() === 1, "判据落库");
    // 默认假 plan 全本地 $0 → auto → 执行器接手出片（6.4），假 build 立刻成功
    await until(() => b.clone.latestReplica(b.templateId)?.status === "done", "复刻片自动出完");
    const full = (await server.inject({ url })).json();
    expect(full.analysis).toEqual({ text: "# ANALYSIS.md\n", truncated: false });
    expect(full.timeline.text).toBe("# TIMELINE.md\n");
    expect(full).toMatchObject({
      svrunExists: true,
      verifying: false,
      verdict: { ok: true },
      replica: { version: 1, status: "done" },
    });
    // 出过片：快照带最新 build id（② 页据此分「估价没过」与「出片失败」）
    expect(full.replica.buildId).toBe(b.build.latestBuild(full.replica.id)?.id);
    await server.close();
  });

  it("超长的分析文件截断给页面并标出来", async () => {
    const b = await boot();
    writeFileSync(path.join(b.workspace, "ANALYSIS.md"), "字".repeat(100_000), "utf8");
    const server = await app();
    const body = (await server.inject({ url: `/api/templates/${b.templateId}/clone` })).json();
    expect(body.analysis.truncated).toBe(true);
    expect(Buffer.byteLength(body.analysis.text, "utf8")).toBeLessThanOrEqual(256 * 1024 + 3);
    await server.close();
  });

  it("ANALYSIS.md 是指向工作目录外的链接：不跟过去，当作没有", async (ctx) => {
    const b = await boot();
    const outside = path.join(b.workspace, "..", "secret.txt");
    writeFileSync(outside, "工作目录外的内容", "utf8");
    try {
      symlinkSync(outside, path.join(b.workspace, "ANALYSIS.md"), "file");
    } catch {
      // Windows 没开开发者模式时普通用户建不了文件符号链接：这条用例在本机跑不了，如实跳过
      ctx.skip();
    }
    const server = await app();
    const body = (await server.inject({ url: `/api/templates/${b.templateId}/clone` })).json();
    expect(body.analysis).toBeNull();
    await server.close();
  });

  it("文件解析到工作目录之外（不靠建符号链接的权限）：不读，当作没有", async () => {
    const b = await boot();
    b.writeProducts(["ANALYSIS.md"]);
    const safe = await import("../lib/safe-path.js");
    vi.spyOn(safe, "isReallyInside").mockReturnValue(false);
    const server = await app();
    const body = (await server.inject({ url: `/api/templates/${b.templateId}/clone` })).json();
    expect(body.analysis).toBeNull();
    await server.close();
  });

  it("模板不存在：404", async () => {
    await boot();
    const server = await app();
    expect((await server.inject({ url: "/api/templates/nope/clone" })).statusCode).toBe(404);
    await server.close();
  });
});

describe("POST /api/templates/:id/clone", () => {
  it("复刻中且从没有过任务：起任务，201", async () => {
    const b = await boot();
    b.setStatus("cloning");
    const server = await app();
    const res = await server.inject({ method: "POST", url: `/api/templates/${b.templateId}/clone` });
    expect(res.statusCode).toBe(201);
    expect(res.json().job).toMatchObject({ ownerId: b.templateId });
    expect(b.latestJob()).toBeDefined();
    await server.close();
  });

  it("还没到复刻这一步：409 NOT_CLONING", async () => {
    const b = await boot();
    const server = await app();
    const res = await server.inject({ method: "POST", url: `/api/templates/${b.templateId}/clone` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NOT_CLONING");
    await server.close();
  });

  it("已经有过任务（哪怕做完了）：409 CLONE_EXISTS，不清掉做好的稿子", async () => {
    const b = await boot();
    // plan 跑不起来 → 复刻片停在待确认、模板留在复刻中：验「有过任务」这条分支
    b.setPlan(new Error("plan 挂了"));
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    await b.finishRun();
    await until(() => b.clone.latestReplica(b.templateId)?.status === "awaiting_cost_confirm", "复刻片待确认");
    const server = await app();
    const res = await server.inject({ method: "POST", url: `/api/templates/${b.templateId}/clone` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "CLONE_EXISTS", message: "这个模板已经复刻完成了，不用再开始" });
    // 做好的稿子还在
    expect(existsSync(path.join(b.workspace, "ANALYSIS.md"))).toBe(true);
    expect(existsSync(path.join(b.workspace, "reference.svrun"))).toBe(true);
    await server.close();
  });

  it("复刻片出完、模板已到待审：409 CLONE_EXISTS（不是「还没到复刻这一步」）", async () => {
    const b = await boot();
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    await b.finishRun();
    // 默认假 plan $0 → auto → 假 build 立刻成功 → 模板转待审
    await until(() => b.templateStatus() === "awaiting_review", "模板待审");
    const server = await app();
    const res = await server.inject({ method: "POST", url: `/api/templates/${b.templateId}/clone` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CLONE_EXISTS");
    await server.close();
  });

  it("工作目录缺 Runtime Profile：清理前的自检拒绝，409 CLONE_NOT_STARTED 带原因，不是 500", async () => {
    const b = await boot();
    b.setStatus("cloning");
    rmSync(path.join(b.workspace, "hypit.runtime.json"));
    const server = await app();
    const res = await server.inject({ method: "POST", url: `/api/templates/${b.templateId}/clone` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CLONE_NOT_STARTED");
    expect(res.json().error.message).toContain("hypit.runtime.json");
    expect(b.latestJob()).toBeUndefined();
    await server.close();
  });
});

describe("POST /api/agent-jobs/:jobId/continue（判据没过之后）", () => {
  it("不带 note 继续：交给会话的是写着没过原因的话，而不是通用的「接着做」", async () => {
    const b = await boot();
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts(["reference.svrun", "TIMELINE.md"]);
    const jobId = await b.finishRun();
    await until(() => b.store.requireJob(jobId).status === "failed", "任务改判失败");

    const Fastify = (await import("fastify")).default;
    const { agentJobRoutes } = await import("./agent-jobs.js");
    const server = Fastify();
    await server.register(agentJobRoutes);
    const res = await server.inject({ method: "POST", url: `/api/agent-jobs/${jobId}/continue` });
    expect(res.statusCode).toBe(200);
    await until(() => b.calls.length === 2, "继续开跑");
    expect(b.calls[1]?.input.prompt).toContain("宿主核对完成判据没有通过：复刻未达完成判据：缺少 ANALYSIS.md");
    await server.close();
  });
});
