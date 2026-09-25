import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { drawerBackend } from "../../test/agent-drawer-kit.js";
import { CLONE_POLL_MS } from "./CloneStep.js";
import {
  agentJob,
  backend,
  EMPTY,
  EVIDENCE_DONE,
  EVIDENCE_FETCHING,
  file,
  mount,
  pushTemplateEvent,
  source,
  stubBuild,
  stubEstimate,
  stubSnapshotFailure,
  TPL,
  setupCloneStep,
} from "../../test/clone-step-kit.js";

/** SCREEN-004 ② 复刻的其它状态：中断无产物、等额度、Agent 快照失败、播放器占位、换模板、轮询开关、取数失败 */

setupCloneStep();

describe("其它状态", () => {
  it("任务已中断、什么都没写出来：一句话指向横条的继续 / 重跑，不给「手动开始复刻」", async () => {
    backend({ job: agentJob({ status: "interrupted", stopReason: "user_abort" }) });
    await mount();
    expect(await screen.findByText(/这次复刻没有写出分析和时间线/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "手动开始复刻" })).toBeNull();
  });

  it("没有任务但已经有文件：不给「手动开始复刻」", async () => {
    backend({ job: null, clone: { ...EMPTY, analysis: file("旧分析") } });
    await mount();
    await screen.findByRole("region", { name: "分析摘要" });
    expect(screen.queryByRole("button", { name: "手动开始复刻" })).toBeNull();
  });

  it("等待额度：工作区里出蓝灰横条，带预计恢复时间", async () => {
    const resumeAt = new Date(2026, 8, 23, 14, 20).toISOString();
    backend({ job: agentJob({ status: "awaiting_quota", resumeAt }) });
    await mount();
    await waitFor(() => {
      const bars = screen.getAllByRole("status");
      expect(bars.some((el) => /额度受限 · 预计 14:20 恢复后自动继续/.test(el.textContent ?? ""))).toBe(true);
    });
  });

  it("Agent 快照读失败：工作区给错误态和重试，重试真的再拉", async () => {
    let fail = true;
    backend({ job: null });
    stubSnapshotFailure(() => fail);
    await mount();
    expect(await screen.findByText("读不到这个模板的 Agent 任务。")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有复刻任务。")).toBeTruthy();
  });

  it("参考视频还没落盘：右侧是占位，时间码不可点", async () => {
    backend({ clone: { ...EMPTY, timeline: file("- 00:00-00:03 开场") }, evidence: { body: EVIDENCE_FETCHING } });
    await mount();
    expect(await screen.findByText("参考视频")).toBeTruthy();
    expect(screen.queryByLabelText("参考视频")).toBeNull();
    const button = await screen.findByRole("button", { name: "00:00-00:03" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("证据状态读不到：只影响播放器占位，页面照常", async () => {
    backend({
      clone: { ...EMPTY, analysis: file("分析") },
      evidence: { status: 500, body: { error: { message: "炸" } } },
    });
    await mount();
    expect(await screen.findByRole("region", { name: "分析摘要" })).toBeTruthy();
    expect(screen.getByText("参考视频 · 读不到准备状态")).toBeTruthy();
  });

  it("换到另一个模板：上一个模板「开始失败」的原文不带过去", async () => {
    backend({
      job: null,
      start: { status: 409, body: { error: { code: "NOT_CLONING", message: "模板还没到复刻这一步" } } },
    });
    const router = await mount();
    await userEvent.click(await screen.findByRole("button", { name: "手动开始复刻" }));
    await screen.findByRole("alert");
    await act(() => router.navigate("/clients/c1/templates/tpl-2/clone"));
    act(() => source("template:tpl-2")?.open());
    // tpl-2 正常打开（有它自己的「手动开始复刻」），且没有 tpl-1 的错误原文
    expect(await screen.findByRole("button", { name: "手动开始复刻" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("估价卡（CMP-006）", () => {
  const REPLICA = { id: "prod-1", version: 1, status: "queued", updatedAt: "", buildId: null };
  const ESTIMATE = {
    id: "e1",
    productionId: "prod-1",
    kind: "ok",
    totalUsd: 0,
    lines: [],
    reason: null,
    decision: "auto",
    reasons: [],
    confirmedAt: null,
    error: null,
    pricingUrls: [],
    createdAt: "",
  };

  it("判据通过、复刻片排上队：右栏出估价卡；没有复刻片时不出", async () => {
    backend({ job: agentJob({ status: "done" }), clone: { ...EMPTY, analysis: file("分析") } });
    await mount();
    await screen.findByRole("region", { name: "分析摘要" });
    expect(screen.queryByRole("region", { name: "出片估价" })).toBeNull();
  });

  it("有复刻片：估价卡出现，结论到了显示金额；estimate 事件让它重拉", async () => {
    const { state } = backend({
      job: agentJob({ status: "done" }),
      clone: { ...EMPTY, analysis: file("分析"), replica: REPLICA },
    });
    await mount();
    expect(await screen.findByRole("region", { name: "出片估价" })).toBeTruthy();
    expect(await screen.findByText(/正在估价/)).toBeTruthy();
    const reads = state.estimateReads;
    // 现在改成有结论了；后端推 estimate 事件
    stubEstimate(ESTIMATE);
    pushTemplateEvent("estimate", { productionId: "prod-1", estimateId: "e1", decision: "auto" });
    // 等待要比估价卡 3 秒一轮的轮询短：只有 estimate 事件能让它这么快重拉，轮询等到的不算（11.4 第九轮审查 R9-M1）
    expect(await screen.findByText("限额内，将自动出片", {}, { timeout: 1500 })).toBeTruthy();
    expect(state.estimateReads).toBeGreaterThan(reads);
  });

  it("估价没过（blocked）的复刻片：状态是失败但没出过片，右栏还是估价卡，带原因和「重新估价」", async () => {
    stubEstimate({
      ...ESTIMATE,
      kind: "blocked",
      decision: "blocked",
      totalUsd: null,
      reason: "plan 有 1 个请求没有 Provider 能接：缺 @hypit/seedance@2#generate-video",
      reasons: [],
    });
    const { state } = backend({
      job: agentJob({ status: "done" }),
      clone: { ...EMPTY, analysis: file("分析"), replica: { ...REPLICA, status: "failed", buildId: null } },
    });
    await mount();
    const card = await screen.findByRole("region", { name: "出片估价" });
    expect(screen.queryByRole("region", { name: "出片" })).toBeNull();
    // 没出过片就不该去拉出片记录（出片卡对 404 会自己隐藏，光看界面分不出来）
    expect(state.buildReads).toBe(0);
    expect(await screen.findByText(/缺 @hypit\/seedance@2#generate-video/)).toBeTruthy();
    expect(within(card).getByRole("button", { name: "重新估价" })).toBeTruthy();
  });

  it("复刻片过了闸门在出片：右栏换成出片卡；build 事件让它重拉", async () => {
    const BUILD = {
      id: "b1",
      productionId: "prod-1",
      status: "failed",
      hypitBuildId: null,
      estimateUsd: 0,
      receiptId: null,
      receiptUrl: null,
      errorCode: "BUILD_FAILED",
      errorMessage: "Command need:… failed",
      outputPath: null,
      startedAt: null,
      endedAt: null,
      createdAt: "",
      context: null,
      activity: null,
      progress: null,
    };
    stubBuild(BUILD);
    const { state } = backend({
      job: agentJob({ status: "done" }),
      clone: { ...EMPTY, analysis: file("分析"), replica: { ...REPLICA, status: "failed", buildId: "b1" } },
    });
    await mount();
    expect(await screen.findByRole("region", { name: "出片" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "出片估价" })).toBeNull();
    expect(await screen.findByText("出片失败")).toBeTruthy();
    const reads = state.buildReads;
    // 重试出完了：后端推 build 事件，卡片重拉
    stubBuild({
      ...BUILD,
      status: "done",
      errorCode: null,
      errorMessage: null,
      outputPath: "X:\\o\\replica-v1-abcd1234.mp4",
    });
    pushTemplateEvent("build", { productionId: "prod-1" });
    expect(await screen.findByText("已出片")).toBeTruthy();
    expect(state.buildReads).toBeGreaterThan(reads);
  });
});

describe("轮询", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("任务结束、判据也核完了：不再轮询", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state } = backend({ job: agentJob({ status: "done" }), clone: { ...EMPTY, analysis: file("分析") } });
    await mount();
    await screen.findByRole("region", { name: "分析摘要" });
    const reads = state.cloneReads;
    await act(() => vi.advanceTimersByTimeAsync(CLONE_POLL_MS * 2 + 100));
    expect(state.cloneReads).toBe(reads);
  });

  it("任务完成但还在核判据：照样轮询，结论出来自己显示", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state } = backend({ job: agentJob({ status: "done" }), clone: { ...EMPTY, verifying: true } });
    await mount();
    await screen.findByText(/正在核对完成判据/);
    state.clone = {
      ...EMPTY,
      verdict: { jobId: "job-1", jobEndedAt: "x", ok: true, missing: [], check: null, error: null, createdAt: "" },
    };
    await act(() => vi.advanceTimersByTimeAsync(CLONE_POLL_MS + 100));
    expect(await screen.findByRole("region", { name: "校验结果" })).toBeTruthy();
  });
});

describe("取数失败", () => {
  it("读不到复刻结果：错误态 + 重试", async () => {
    drawerBackend(
      { job: null },
      {
        [`/api/templates/${TPL}/clone`]: { status: 500, body: { error: { message: "炸了" } } },
        [`/api/templates/${TPL}/evidence`]: { body: EVIDENCE_DONE },
      },
    );
    await mount();
    expect(await screen.findByText(/读不到复刻结果/)).toBeTruthy();
  });
});
