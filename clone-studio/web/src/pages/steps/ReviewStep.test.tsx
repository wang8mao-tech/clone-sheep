import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { agentJob } from "../../test/agent-fixtures.js";
import { drawerBackend, TPL } from "../../test/agent-drawer-kit.js";
import { ControlledEventSource } from "../../test/fake-event-source.js";
import { backend, installReviewSources, mount, rightVideo, state, version } from "../../test/review-kit.js";

/** SCREEN-005 ③ 验货：并排播放器、版本切换、通过（跳 ④）、打回（意见框、跳 ②）、出片卡回退、状态刷新（AC-012 / AC-013 / AC-040 前端） */

beforeEach(() => {
  installReviewSources();
});

describe("并排播放与版本", () => {
  it("左原片右复刻片 v1，右路放出片单位的 mp4，逐帧按原片探测到的 fps", async () => {
    backend(state());
    await mount();
    expect((await rightVideo("原片")).getAttribute("src")).toContain(`/api/templates/${TPL}/reference/video`);
    expect((await rightVideo("复刻片 v1")).getAttribute("src")).toBe("/api/productions/p1/video");
    expect(screen.getByRole("slider", { name: "进度" })).toHaveAttribute("step", String(1 / 25));
  });

  it("两个版本：分段控件切到 v1 时右路换成 v1，「通过验货」只对最新一版可用", async () => {
    backend(state({ versions: [version(1), version(2)], nextRound: 3 }));
    const { user } = await mount();
    expect(await rightVideo("复刻片 v2")).toBeInTheDocument();
    await user.click(within(screen.getByRole("group", { name: "版本" })).getByRole("button", { name: "v1" }));
    expect((await rightVideo("复刻片 v1")).getAttribute("src")).toBe("/api/productions/p1/video");
    const approve = screen.getByRole("button", { name: "通过验货" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute("title", "只能通过最新一版 v2");
  });

  it("选中的那一版没出好（出片失败）：右边换成出片卡，给原文与重试", async () => {
    backend(state({ versions: [version(1), version(2, { status: "failed", videoUrl: null })], approvable: false }));
    await mount();
    const card = await screen.findByRole("region", { name: "出片" });
    expect(within(card).getByText("渲染炸了")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "重试出片" })).toBeInTheDocument();
  });

  it("两片元数据到了：显示时长差与分辨率", async () => {
    backend(state());
    await mount();
    const pair: Array<[string, number, number, number]> = [
      ["原片", 13.9, 720, 1280],
      ["复刻片 v1", 14.3, 1080, 1920],
    ];
    for (const [label, d, w, h] of pair) {
      const v = await rightVideo(label);
      Object.defineProperty(v, "duration", { configurable: true, value: d });
      Object.defineProperty(v, "videoWidth", { configurable: true, value: w });
      Object.defineProperty(v, "videoHeight", { configurable: true, value: h });
      fireEvent.loadedMetadata(v);
    }
    expect(
      await screen.findByText("时长差 +0.4s（复刻片更长） · 分辨率 原片 720×1280 / 复刻片 1080×1920"),
    ).toBeInTheDocument();
  });
});

describe("差异行跟着版本走（7.3 审查 MEDIUM-1）", () => {
  it("v2 的差已经算出来，切到 v1（元数据还没到）：不拿 v2 的数冒充 v1", async () => {
    backend(state({ versions: [version(1), version(2)], nextRound: 3 }));
    const { user } = await mount();
    for (const [label, d] of [
      ["原片", 13.9],
      ["复刻片 v2", 14.3],
    ] as const) {
      const v = await rightVideo(label);
      Object.defineProperty(v, "duration", { configurable: true, value: d });
      Object.defineProperty(v, "videoWidth", { configurable: true, value: 720 });
      Object.defineProperty(v, "videoHeight", { configurable: true, value: 1280 });
      fireEvent.loadedMetadata(v);
    }
    expect(await screen.findByText(/时长差 \+0\.4s/)).toBeInTheDocument();
    await user.click(within(screen.getByRole("group", { name: "版本" })).getByRole("button", { name: "v1" }));
    expect(screen.queryByText(/时长差/)).not.toBeInTheDocument();
  });
});

describe("通过验货（AC-040 前端）", () => {
  it("点「通过验货」：提交最新一版的 id，成功后跳到 ④ 变体", async () => {
    const db = backend(state());
    const { router, user } = await mount();
    await user.click(await screen.findByRole("button", { name: "通过验货" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/clients/c1/templates/${TPL}/variants`));
    expect(db.approved).toEqual([{ productionId: "p1" }]);
  });

  it("已经通过了：徽标写明是哪一版，通过与打回都不可用", async () => {
    backend(state({ templateStatus: "approved", approvedReplicaId: "p1", approvable: false, reworkable: false }));
    await mount();
    expect(await screen.findByText("已通过验货 · v1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "通过验货" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "打回" })).toHaveAttribute("title", "已经通过验货了，不能打回");
  });
});

describe("打回（AC-013 前端）", () => {
  it("展开意见框（第 2 轮）→ 空的不能提交 → 写了提交，意见原文发出去，跳回 ② 看改稿", async () => {
    const db = backend(state());
    const { router, user } = await mount();
    await user.click(await screen.findByRole("button", { name: "打回" }));
    const box = screen.getByLabelText("打回意见 #2");
    expect(screen.getByRole("button", { name: "提交打回" })).toBeDisabled();
    await user.type(box, "主持人太小，放大到画面一半");
    expect(screen.getByText("13 / 2000")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "提交打回" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/clients/c1/templates/${TPL}/clone`));
    expect(db.reworks).toEqual([{ note: "主持人太小，放大到画面一半" }]);
  });

  it("打回提交中：「通过验货」不可点，写明在提交打回", async () => {
    backend(state());
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/rework")) return new Promise<Response>(() => undefined);
      return inner(input, init);
    });
    const { user } = await mount();
    await user.click(await screen.findByRole("button", { name: "打回" }));
    await user.type(screen.getByLabelText("打回意见 #2"), "改一下");
    await user.click(screen.getByRole("button", { name: "提交打回" }));
    const approve = screen.getByRole("button", { name: "通过验货" });
    await waitFor(() => expect(approve).toBeDisabled());
    expect(approve).toHaveAttribute("title", "正在提交打回");
  });

  it("意见超过 2000 字：红字提示、提交不可用", async () => {
    backend(state());
    const { user } = await mount();
    await user.click(await screen.findByRole("button", { name: "打回" }));
    fireEvent.change(screen.getByLabelText("打回意见 #2"), { target: { value: "字".repeat(2001) } });
    expect(screen.getByText("超过 2000 字了（2001）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交打回" })).toBeDisabled();
  });
});

describe("刷新与错误", () => {
  it("后端推 review / build 事件：重拉验货状态", async () => {
    const db = backend(state());
    await mount();
    await rightVideo("复刻片 v1");
    const before = db.reads;
    act(() => {
      for (const es of ControlledEventSource.instances) {
        if (!es.closed && es.topics.includes(`template:${TPL}`)) es.emit("review", `template:${TPL}`, {});
      }
    });
    await waitFor(() => expect(db.reads).toBeGreaterThan(before));
  });

  it("读不到验货状态：错误态，不是空白", async () => {
    drawerBackend(
      { job: agentJob({ status: "done" }) },
      { [`/api/templates/${TPL}/review`]: { status: 500, body: { error: { code: "X", message: "炸了" } } } },
    );
    await mount();
    expect(await screen.findByText("读不到验货状态")).toBeInTheDocument();
  });
});
