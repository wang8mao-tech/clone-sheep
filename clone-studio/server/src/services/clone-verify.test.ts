import { describe, expect, it } from "vitest";
import { boot, CHECK_OK, tick, until, uploadFile, useCloneSandbox, type Booted } from "./clone-test-kit.js";

/** 复刻完成判据（REQ-004）：宿主自己核、结论绑到那一次完成、不过就改判失败、核不了也要有出口 */

useCloneSandbox();

async function cloning(b: Booted, files?: readonly string[]) {
  b.setStatus("cloning");
  b.clone.startClone(b.templateId);
  b.writeProducts(files);
}

const statusOf = (b: Booted, jobId: string) => b.store.requireJob(jobId).status;

describe("判据", () => {
  it("三个文件都在且 check 通过：判定通过，建 v1 复刻片，任务保持完成", async () => {
    const b = await boot();
    await cloning(b);
    const jobId = await b.finishRun();
    await until(() => b.verdictCount() === 1, "判据落库");

    const job = b.store.requireJob(jobId);
    expect(b.verdicts.verdictFor(jobId, job.ended_at)).toMatchObject({ ok: true, missing: [], error: null });
    // 显式 --workspace（REQ-002 MUST「所有 hypit 调用显式 --workspace」）
    expect(b.hypitCalls).toContainEqual(["check", "reference.svrun", "--workspace", b.workspace, "--json"]);
    expect(job.status).toBe("done");
    expect(b.clone.latestReplica(b.templateId)).toMatchObject({
      version: 1,
      status: "queued",
      run_path: "reference.svrun",
    });
  });

  it("缺 ANALYSIS.md：任务改判失败并写明缺什么，不建复刻片", async () => {
    const b = await boot();
    await cloning(b, ["reference.svrun", "TIMELINE.md"]);
    const jobId = await b.finishRun();
    await until(() => statusOf(b, jobId) === "failed", "任务改判失败");

    expect(b.store.requireJob(jobId).stop_reason).toBe("复刻未达完成判据：缺少 ANALYSIS.md");
    expect(b.clone.currentVerdict(b.templateId).verdict).toMatchObject({ ok: false, missing: ["ANALYSIS.md"] });
    expect(b.clone.latestReplica(b.templateId)).toBeUndefined();
  });

  it("没有 reference.svrun：不跑 check，直接判不过", async () => {
    const b = await boot();
    await cloning(b, ["ANALYSIS.md", "TIMELINE.md"]);
    const jobId = await b.finishRun();
    await until(() => statusOf(b, jobId) === "failed", "任务改判失败");

    expect(b.hypitCalls.some((c) => c[0] === "check")).toBe(false);
    expect(b.clone.currentVerdict(b.templateId).verdict?.missing).toEqual(["reference.svrun"]);
  });

  // 防御：hypit 0.2.6 的 check 失败走 cli-error（下一条），cli-check@1 恒为 ok:true。万一版本变了给出 ok:false，
  // 也要判不过，且停止原因带上它的第一条诊断
  it("（防御）check 的 JSON 说 ok:false：判不过，原样留下 check 输出，停止原因带第一条诊断", async () => {
    const b = await boot();
    b.setCheck({ format: "hypit.cli-check@1", ok: false, diagnostics: ["坏了"] });
    await cloning(b);
    const jobId = await b.finishRun();
    await until(() => statusOf(b, jobId) === "failed", "任务改判失败");

    expect(b.clone.currentVerdict(b.templateId).verdict?.check).toEqual({
      format: "hypit.cli-check@1",
      ok: false,
      diagnostics: ["坏了"],
    });
    expect(b.store.requireJob(jobId).stop_reason).toBe("复刻未达完成判据：hypit check 未通过：坏了");
  });

  it("check 报错（HypitError，带 stderr 原文，和 runHypit 真实抛的一样）：原文整段进结论，停止原因只取第一行", async () => {
    const b = await boot();
    const { HypitError } = await import("../hypit/cli.js");
    b.setCheck(
      new HypitError("SVML_PARSE", "第 3 行语法错误", "看看缩进", "loading reference.svrun\nparse failed at 3:7"),
    );
    await cloning(b);
    const jobId = await b.finishRun();
    await until(() => statusOf(b, jobId) === "failed", "任务改判失败");

    expect(b.clone.currentVerdict(b.templateId).verdict?.error).toBe(
      "第 3 行语法错误\n看看缩进\nloading reference.svrun\nparse failed at 3:7",
    );
    expect(b.store.requireJob(jobId).stop_reason).toBe("复刻未达完成判据：hypit check 未通过：第 3 行语法错误");
  });

  it("核的过程本身出错：也记成失败结论并改判，人能继续 / 重跑，而不是停在一个没核过的「完成」", async () => {
    const b = await boot();
    await cloning(b);
    // 核到一半工作目录没了：requireTemplate 读到的 workspace_path 是空
    b.db().prepare("UPDATE templates SET workspace_path = NULL WHERE id = ?").run(b.templateId);
    const jobId = await b.finishRun();
    await until(() => statusOf(b, jobId) === "failed", "任务改判失败");

    expect(b.store.requireJob(jobId).stop_reason).toMatch(/^复刻未达完成判据：核对完成判据时出错：.*没有工作目录/);
  });
});

describe("继续之后", () => {
  it("判不过后「继续」：交给会话的话里带着没过的原因；补齐再完成，同一个任务重新核，这次通过", async () => {
    const b = await boot();
    await cloning(b, ["reference.svrun"]);
    const jobId = await b.finishRun();
    await until(() => statusOf(b, jobId) === "failed", "第一次判不过");

    const prompt = b.clone.continuePromptFor(jobId);
    expect(prompt).toContain("缺少 ANALYSIS.md、TIMELINE.md");
    b.service.agentScheduler().continueJob(jobId, prompt);
    // 继续之后、再次完成之前，页面不该还显示上一次的失败结论
    expect(b.clone.currentVerdict(b.templateId)).toEqual({ verdict: null, verifying: false });
    await until(() => b.calls.length === 2, "继续开跑");
    expect(b.calls[1]?.input.prompt).toBe(prompt);

    b.writeProducts();
    await b.finishRun(1);
    await until(() => b.verdictCount() === 2, "第二次判据落库");
    expect(b.clone.currentVerdict(b.templateId).verdict?.ok).toBe(true);
    expect(statusOf(b, jobId)).toBe("done");
    expect(b.clone.latestReplica(b.templateId)?.version).toBe(1);
  });

  it("通过了的任务、或会话没起来的任务：不给定制的继续提示", async () => {
    const b = await boot();
    await cloning(b);
    const jobId = await b.finishRun();
    await until(() => b.verdictCount() === 1, "判据落库");
    expect(b.clone.continuePromptFor(jobId)).toBeUndefined();
  });
});

describe("核的过程中情况变了", () => {
  it("还在核时上面起了新一轮：旧结论照记，但不建复刻片、也不算新一轮的结论", async () => {
    const b = await boot();
    let release: (v: Record<string, unknown>) => void = () => undefined;
    b.setCheck(() => new Promise((resolve) => (release = resolve)));
    await cloning(b);
    await b.finishRun();
    await until(() => b.hypitCalls.some((c) => c[0] === "check"), "开始核");
    expect(b.clone.currentVerdict(b.templateId)).toEqual({ verdict: null, verifying: true });

    const next = b.clone.startClone(b.templateId);
    expect(next).toBeDefined();
    release(CHECK_OK);
    await until(() => b.verdictCount() === 1, "旧结论落库");

    expect(b.clone.latestReplica(b.templateId)).toBeUndefined();
    expect(b.clone.currentVerdict(b.templateId)).toEqual({ verdict: null, verifying: false });
  });

  it("继续后再次完成、还在核：页面看到「核对中」，不是上一次的失败结论", async () => {
    const b = await boot();
    await cloning(b, ["reference.svrun"]);
    const jobId = await b.finishRun();
    await until(() => statusOf(b, jobId) === "failed", "第一次判不过");

    let release: (v: Record<string, unknown>) => void = () => undefined;
    b.setCheck(() => new Promise((resolve) => (release = resolve)));
    b.service.agentScheduler().continueJob(jobId, b.clone.continuePromptFor(jobId));
    b.writeProducts();
    await b.finishRun(1);
    await until(() => b.hypitCalls.filter((c) => c[0] === "check").length === 2, "开始第二次核");
    expect(b.clone.currentVerdict(b.templateId)).toEqual({ verdict: null, verifying: true });

    release(CHECK_OK);
    await until(() => b.verdictCount() === 2, "第二次结论落库");
    expect(b.clone.currentVerdict(b.templateId)).toMatchObject({ verdict: { ok: true }, verifying: false });
  });

  it("改判只动仍是「完成」、仍是最新、仍是同一次完成的任务", async () => {
    const b = await boot({ register: false });
    b.setStatus("cloning");
    const first = b.clone.startClone(b.templateId) as { id: string };
    await until(() => b.calls.length === 1, "会话开跑");
    expect(b.service.failFinishedJob(first.id, "运行中不该生效")).toBeUndefined();

    const doneId = await b.finishRun();
    const endedAt = b.store.requireJob(doneId).ended_at;
    expect(b.service.failFinishedJob(doneId, "别的那次完成", "2000-01-01T00:00:00.000Z")).toBeUndefined();
    expect(statusOf(b, doneId)).toBe("done");

    b.clone.startClone(b.templateId);
    expect(b.service.failFinishedJob(doneId, "已经不是最新", endedAt)).toBeUndefined();
    expect(statusOf(b, doneId)).toBe("done");
  });
});

describe("换参考视频", () => {
  it("判据通过后换参考视频、新证据失败：旧复刻片作废，不会留着等估价", async () => {
    const b = await boot();
    await cloning(b);
    await b.finishRun();
    await until(() => b.clone.latestReplica(b.templateId)?.status === "queued", "旧复刻片排队");

    b.setFail("media probe", new Error("新视频坏了"));
    await b.evidence.startEvidence({
      templateId: b.templateId,
      source: { kind: "file", path: uploadFile() },
      language: "zh",
    });
    await until(() => b.evidence.evidenceState(b.templateId).status === "failed", "新证据失败");
    expect(b.clone.latestReplica(b.templateId)).toBeUndefined();
  });

  it("还在核时换了参考视频（走真的 startEvidence）：核完不建复刻片，新证据失败也不留排队的旧复刻片", async () => {
    // 第三轮审查复现的竞态：作废旧复刻片若早于模板离开 cloning，中间 rm 的 await 空当里核完的那一轮会再建一条
    const b = await boot();
    let release: (v: Record<string, unknown>) => void = () => undefined;
    b.setCheck(() => new Promise((resolve) => (release = resolve)));
    await cloning(b);
    await b.finishRun();
    await until(() => b.hypitCalls.some((c) => c[0] === "check"), "开始核");

    b.setFail("media probe", new Error("新视频坏了"));
    release(CHECK_OK);
    await b.evidence.startEvidence({
      templateId: b.templateId,
      source: { kind: "file", path: uploadFile() },
      language: "zh",
    });
    await until(() => b.evidence.evidenceState(b.templateId).status === "failed", "新证据失败");
    await until(() => b.verdictCount() === 1, "结论落库");
    expect(b.clone.latestReplica(b.templateId)).toBeUndefined();
  });
  it("核完时模板已经离开复刻中（作废之后才核完）：不建复刻片", async () => {
    const b = await boot();
    let release: (v: Record<string, unknown>) => void = () => undefined;
    b.setCheck(() => new Promise((resolve) => (release = resolve)));
    await cloning(b);
    await b.finishRun();
    await until(() => b.hypitCalls.some((c) => c[0] === "check"), "开始核");

    b.setStatus("importing");
    release(CHECK_OK);
    await until(() => b.verdictCount() === 1, "结论落库");
    expect(b.clone.latestReplica(b.templateId)).toBeUndefined();
  });
});

describe("重启与监听", () => {
  it("进程在核的时候退出：重启接上编排后补核那一次完成，不起新任务", async () => {
    const b = await boot({ register: false });
    await cloning(b);
    const jobId = await b.finishRun();
    expect(b.verdictCount()).toBe(0);

    b.register();
    await until(() => b.verdictCount() === 1, "补核落库");
    expect(b.clone.currentVerdict(b.templateId).verdict?.ok).toBe(true);
    expect(b.db().prepare("SELECT COUNT(*) AS n FROM agent_jobs").get()).toEqual({ n: 1 });
    expect(statusOf(b, jobId)).toBe("done");
  });

  it("已经核过的完成：重启不再核一遍", async () => {
    // 真的重启：进程内的去重记录是空的，只能靠库里的结论认出「核过了」
    const b = await boot({ register: false });
    await cloning(b);
    const jobId = await b.finishRun();
    await b.clone.verifyClone(b.store.requireJob(jobId));
    expect(b.verdictCount()).toBe(1);

    b.register();
    await tick();
    await tick();
    expect(b.verdictCount()).toBe(1);
  });

  it("某个监听方抛错：不影响调度器把任务状态写进库", async () => {
    const b = await boot({ register: false });
    b.service.onJobChange(() => {
      throw new Error("监听方炸了");
    });
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    const jobId = await b.finishRun();
    await tick();
    expect(statusOf(b, jobId)).toBe("done");
  });
});
