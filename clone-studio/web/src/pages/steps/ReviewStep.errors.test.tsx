import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { TPL } from "../../test/agent-drawer-kit.js";
import { backend, installReviewSources, mount, state } from "../../test/review-kit.js";

/** ③ 验货的失败路径：被拒要说清是哪个动作、重拉状态；两个动作互斥；参考视频只加载一次（7.3 第二轮审查 M-1） */

beforeEach(() => {
  installReviewSources();
});

const rejected = (code: string, message: string) => ({ status: 409, body: { error: { code, message } } });

/** 让某个接口一直不回（提交中） */
function hang(part: string): void {
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(part)) return new Promise<Response>(() => undefined);
    return inner(input, init);
  });
}

describe("通过 / 打回被拒", () => {
  it("通过被拒（不是最新一版）：红字写明是通过没成功 + 服务端原因，并重拉验货状态", async () => {
    const db = backend(state(), {
      [`POST /api/templates/${TPL}/approve`]: rejected("NOT_LATEST", "只能通过最新一版 v2"),
    });
    const { user } = await mount();
    const button = await screen.findByRole("button", { name: "通过验货" });
    const before = db.reads;
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("通过验货没成功：只能通过最新一版 v2");
    await waitFor(() => expect(db.reads).toBeGreaterThan(before));
  });

  it("先通过失败、再打回失败：显示后发生的打回错误，不被旧的通过错误盖住", async () => {
    const db = backend(state(), {
      [`POST /api/templates/${TPL}/approve`]: rejected("AGENT_ACTIVE", "复刻任务还在跑"),
      [`POST /api/templates/${TPL}/rework`]: rejected("NOT_REWORKABLE", "会话已经没了，不能打回"),
    });
    const { user } = await mount();
    await user.click(await screen.findByRole("button", { name: "通过验货" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("通过验货没成功：复刻任务还在跑");
    const readsAfterApprove = db.reads;
    await user.click(screen.getByRole("button", { name: "打回" }));
    await user.type(screen.getByLabelText("打回意见 #2"), "改一下");
    await user.click(screen.getByRole("button", { name: "提交打回" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("打回没提交：会话已经没了，不能打回"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("复刻任务还在跑");
    // 打回被拒也重拉一次状态
    await waitFor(() => expect(db.reads).toBeGreaterThan(readsAfterApprove));
  });

  it("通过提交中：「打回」不可点，写明在提交通过验货", async () => {
    backend(state());
    hang("/approve");
    const { user } = await mount();
    await user.click(await screen.findByRole("button", { name: "通过验货" }));
    const rework = screen.getByRole("button", { name: "打回" });
    await waitFor(() => expect(rework).toBeDisabled());
    expect(rework).toHaveAttribute("title", "正在提交通过验货");
  });
});

describe("参考视频只加载一次", () => {
  it("证据状态晚回来：先不挂播放器，原片地址只出现带取证时间的那一个", async () => {
    backend(state());
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/evidence")) await new Promise((r) => setTimeout(r, 60));
      return inner(input, init);
    });
    const seen = new Set<string>();
    const record = () =>
      document.querySelectorAll<HTMLVideoElement>('video[aria-label="原片"]').forEach((v) => {
        const src = v.getAttribute("src");
        if (src) seen.add(src);
      });
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
    await mount();
    expect(await screen.findByText("读取参考视频…")).toBeInTheDocument();
    await screen.findByLabelText("原片", { selector: "video" });
    record();
    observer.disconnect();
    expect([...seen]).toEqual([
      `/api/templates/${TPL}/reference/video?v=${encodeURIComponent("2026-09-23T10:00:00.000Z")}`,
    ]);
  });
});

describe("边界", () => {
  it("意见只有空白：按去首尾空白计 0 字，不能提交", async () => {
    backend(state());
    const { user } = await mount();
    await user.click(await screen.findByRole("button", { name: "打回" }));
    await user.type(screen.getByLabelText("打回意见 #2"), "   ");
    expect(screen.getByText("0 / 2000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交打回" })).toBeDisabled();
  });

  it("这一轮还没有复刻片：说明出好后在这里对比，不挂播放器也不崩", async () => {
    backend(state({ versions: [], approvable: false, reworkable: false }));
    await mount();
    expect(await screen.findByText("这一轮还没有复刻片，出好后在这里和原片并排对比。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "通过验货" })).not.toBeInTheDocument();
  });
});
