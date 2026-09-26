import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CLONE_POLL_MS } from "./CloneStep.js";
import {
  agentJob,
  backend,
  EMPTY,
  file,
  mount,
  pushClone,
  pushTemplateEvent,
  setupCloneStep,
} from "../../test/clone-step-kit.js";

/** SCREEN-004 ② 复刻：三个区块随文件逐个出现、刷新路径、时间码跳参考播放器、判据未过的原文、手动开始 */

setupCloneStep();

describe("三个区块随文件逐个出现", () => {
  it("还没有文件：三个区块都不出现，运行中写明「复刻进行中」", async () => {
    backend();
    await mount();
    expect(await screen.findByText("复刻进行中")).toBeTruthy();
    expect(screen.getByText("分析摘要、时间线写出来后会依次出现在这里。")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "分析摘要" })).toBeNull();
    expect(screen.queryByRole("region", { name: "时间线" })).toBeNull();
    expect(screen.queryByRole("region", { name: "校验结果" })).toBeNull();
  });

  it("先有 ANALYSIS.md，再有 TIMELINE.md，判据出来后才有校验结果（clone 事件触发重拉）", async () => {
    const { state } = backend({ clone: { ...EMPTY, analysis: file("结构：排行榜。") } });
    await mount();
    expect(await screen.findByRole("region", { name: "分析摘要" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "时间线" })).toBeNull();

    state.clone = { ...state.clone, timeline: file("- 00:00.0-00:03.5 开场") };
    pushClone();
    expect(await screen.findByRole("region", { name: "时间线" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "校验结果" })).toBeNull();

    state.clone = {
      ...state.clone,
      svrunExists: true,
      verdict: {
        jobId: "job-1",
        jobEndedAt: "2026-09-23T10:05:00.000Z",
        ok: true,
        missing: [],
        check: { run: "reference.svrun", targetCount: 1 },
        error: null,
        createdAt: "",
      },
    };
    pushClone();
    const verdict = await screen.findByRole("region", { name: "校验结果" });
    expect(within(verdict).getByText(/hypit check 通过/)).toBeTruthy();
    expect(within(verdict).getByText("reference.svrun · 1 个目标")).toBeTruthy();
  });

  it("「不确定项」逐条标琥珀徽标，正文照常渲染", async () => {
    backend({
      clone: { ...EMPTY, analysis: file("## 结构\n榜单解说。\n\n## 不确定项\n- 背景音乐来源不明\n- 字体无法识别\n") },
    });
    await mount();
    const region = await screen.findByRole("region", { name: "分析摘要" });
    expect(within(region).getByText("榜单解说。")).toBeTruthy();
    const items = within(region).getByRole("list", { name: "不确定项" });
    expect(within(items).getByText("不确定项 2")).toBeTruthy();
    expect(within(items).getByText("字体无法识别")).toBeTruthy();
  });

  it("区块可以折叠", async () => {
    backend({ clone: { ...EMPTY, analysis: file("榜单解说。") } });
    await mount();
    const toggle = await screen.findByRole("button", { name: /分析摘要/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("榜单解说。")).toBeNull();
  });
});

describe("文件没有事件，靠这两条路刷新", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("任务在跑：按间隔重拉，新写出的文件自己冒出来", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { state } = backend();
    await mount();
    await screen.findByText("复刻进行中");
    state.clone = { ...EMPTY, analysis: file("刚写出来的分析") };
    await act(() => vi.advanceTimersByTimeAsync(CLONE_POLL_MS + 100));
    expect(await screen.findByText("刚写出来的分析")).toBeTruthy();
  });

  it("任务一结束立刻补拉一次，不等下一轮", async () => {
    const { state, drawer } = backend();
    await mount();
    await screen.findByText("复刻进行中");
    state.clone = { ...EMPTY, timeline: file("- 00:00-00:02 最后一段") };
    drawer.db.job = agentJob({ status: "done" });
    pushTemplateEvent("agent-job", drawer.db.job);
    expect(await screen.findByRole("region", { name: "时间线" }, { timeout: 1500 })).toBeTruthy();
    expect(screen.queryByText("复刻进行中")).toBeNull();
  });
});

describe("核对中", () => {
  it("Agent 报完成、宿主还在核判据：写明正在核对，不出校验结果区块", async () => {
    backend({ job: agentJob({ status: "done" }), clone: { ...EMPTY, analysis: file("分析"), verifying: true } });
    await mount();
    expect(await screen.findByText(/正在核对完成判据/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "校验结果" })).toBeNull();
  });
});

describe("时间码联动参考播放器", () => {
  it("点时间码，参考视频跳到该处", async () => {
    backend({ clone: { ...EMPTY, timeline: file("| 00:03.5-00:11 | 第一段观点 |\n| 01:02 | 收尾 |") } });
    await mount();
    await screen.findByRole("region", { name: "时间线" });
    const video = await screen.findByLabelText<HTMLVideoElement>("参考视频");

    await userEvent.click(screen.getByRole("button", { name: "00:03.5-00:11" }));
    expect(video.currentTime).toBe(3.5);
    await userEvent.click(screen.getByRole("button", { name: "01:02" }));
    expect(video.currentTime).toBe(62);
  });
});

describe("校验结果未过", () => {
  it("写明缺什么，并原样给出 check 的报错", async () => {
    backend({
      job: agentJob({ status: "failed", stopReason: "复刻未达完成判据：缺少 ANALYSIS.md" }),
      clone: {
        ...EMPTY,
        verdict: {
          jobId: "job-1",
          jobEndedAt: "2026-09-23T10:05:00.000Z",
          ok: false,
          missing: ["ANALYSIS.md"],
          check: null,
          error: "第 3 行语法错误",
          createdAt: "",
        },
      },
    });
    await mount();
    const region = await screen.findByRole("region", { name: "校验结果" });
    expect(within(region).getByText("✕ 未达完成判据", { exact: false })).toBeTruthy();
    expect(within(region).getByText("缺少 ANALYSIS.md")).toBeTruthy();
    expect(within(region).getByText("第 3 行语法错误")).toBeTruthy();
  });
});

describe("没有任务", () => {
  it("给「开始复刻」，点了起任务、抽屉数据跟着换", async () => {
    const { state } = backend({ job: null });
    await mount();
    await userEvent.click(await screen.findByRole("button", { name: "手动开始复刻" }));
    await waitFor(() => expect(state.startCalls).toBe(1));
    expect(await screen.findByText("复刻排队中")).toBeTruthy();
  });

  it("开始失败：原文显示出来", async () => {
    backend({
      job: null,
      start: { status: 409, body: { error: { code: "NOT_CLONING", message: "模板还没到复刻这一步" } } },
    });
    await mount();
    await userEvent.click(await screen.findByRole("button", { name: "手动开始复刻" }));
    expect((await screen.findByRole("alert")).textContent).toContain("模板还没到复刻这一步");
  });
});
