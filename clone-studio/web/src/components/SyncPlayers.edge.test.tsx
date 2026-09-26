import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SyncPlayers } from "./SyncPlayers.js";
import { breakMedia, playToEnd, rejectNextPlay, setMediaDuration, setMediaReadyState } from "../test/media.js";
import { mount, playButton, refill, starve } from "../test/sync-players-kit.js";

/** CMP-004 的边界：缓冲误报与恢复信号、两片时长不一样、换片、出错、加载、键盘（7.1 审查补的） */

describe("缓冲误报与恢复信号（7.1 审查 H1）", () => {
  it("数据其实够的 stalled（Chromium 误报）不当缓冲：两路照播", async () => {
    const { left, right, user } = mount();
    await user.click(playButton());
    fireEvent(right, new Event("stalled"));
    expect([left.paused, right.paused]).toEqual([false, false]);
    expect(screen.queryByText("缓冲中")).not.toBeInTheDocument();
  });

  it.each(["canplaythrough", "playing"] as const)("没有 canplay、只来了 %s：也算数据回来了，恢复播放", async (evt) => {
    const { left, right, user } = mount();
    await user.click(playButton());
    starve(right, "stalled");
    refill(right, evt);
    expect([left.paused, right.paused]).toEqual([false, false]);
    expect(screen.queryByText("缓冲中")).not.toBeInTheDocument();
  });

  it("缓冲登记之后什么事件都没来、但数据已经够了：暂停再点播放就能播，不会卡死", async () => {
    const { left, right, user } = mount();
    await user.click(playButton());
    starve(right, "stalled");
    expect(screen.getByText("缓冲中")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "暂停" }));
    setMediaReadyState(right, 4); // 数据回来了，浏览器却没派发任何事件
    await user.click(playButton());
    expect([left.paused, right.paused]).toEqual([false, false]);
    expect(screen.queryByText("缓冲中")).not.toBeInTheDocument();
  });
});

describe("两片时长不一样（7.1 审查 H2）", () => {
  it("复刻片短、先播完：原片接着播、进度条跟原片；拖回去两路一起接着播", async () => {
    const { left, right, user } = mount(undefined, [12, 8]);
    await user.click(playButton());
    playToEnd(right);
    expect([left.paused, right.paused]).toEqual([false, true]);
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "进度" }), { target: { value: "3" } });
    expect([left.currentTime, right.currentTime]).toEqual([3, 3]);
    expect([left.paused, right.paused]).toEqual([false, false]);
  });

  it("短的那路播完停在末帧：另一路缓冲恢复时不会把它重新播起来", async () => {
    const { left, right, user } = mount(undefined, [12, 8]);
    await user.click(playButton());
    playToEnd(right);
    starve(left);
    refill(left);
    expect([left.paused, right.paused]).toEqual([false, true]);
    expect(right.currentTime).toBe(8);
  });

  it("原片短、先播完：进度条改由复刻片推进；拖回去原片也跟上", async () => {
    const { left, right, user } = mount(undefined, [8, 12]);
    await user.click(playButton());
    playToEnd(left);
    right.currentTime = 9.5;
    fireEvent.timeUpdate(right);
    expect(screen.getByText("0:09 / 0:12")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "进度" }), { target: { value: "3" } });
    expect([left.paused, right.paused]).toEqual([false, false]);
    left.currentTime = 4;
    fireEvent.timeUpdate(left);
    expect(screen.getByText("0:04 / 0:12")).toBeInTheDocument();
  });

  it("两路都播到尾：按钮回到「播放」，再点从头播", async () => {
    const { left, right, user } = mount(undefined, [8, 8]);
    await user.click(playButton());
    playToEnd(left);
    playToEnd(right);
    expect(playButton()).toBeInTheDocument();
    await user.click(playButton());
    expect([left.currentTime, right.currentTime]).toEqual([0, 0]);
    expect([left.paused, right.paused]).toEqual([false, false]);
  });
});

describe("换片、出错、加载（7.1 审查 M1 / M3 / M4）", () => {
  it("播放中换了右路的片（v1 → v2）：新片加载出元数据后对齐进度、接着播", async () => {
    const { left, right, user, view } = mount();
    await user.click(playButton());
    left.currentTime = 5;
    view.rerender(
      <SyncPlayers
        left={{ label: "原片", src: "/api/templates/t1/reference/video" }}
        right={{ label: "复刻片 v1", src: "/api/productions/p2/video" }}
      />,
    );
    // 浏览器换 src 时会把元素停下
    right.pause();
    fireEvent.loadedMetadata(right);
    expect(right.currentTime).toBe(5);
    expect([left.paused, right.paused]).toEqual([false, false]);
  });

  it("暂停时换片：新片加载出元数据后对齐到另一路的进度，保持暂停", () => {
    const { left, right, view } = mount();
    left.currentTime = 6;
    view.rerender(
      <SyncPlayers
        left={{ label: "原片", src: "/api/templates/t1/reference/video" }}
        right={{ label: "复刻片 v1", src: "/api/productions/p2/video" }}
      />,
    );
    fireEvent.loadedMetadata(right);
    expect(right.currentTime).toBe(6);
    expect([left.paused, right.paused]).toEqual([true, true]);
  });

  it("加载出元数据时回报时长与分辨率（页面算两片的差）", () => {
    const seen: Array<[string, number]> = [];
    render(
      <SyncPlayers
        left={{ label: "原片", src: "/a" }}
        right={{ label: "复刻片 v1", src: "/b" }}
        onMeta={(side, meta) => seen.push([side, meta.duration])}
      />,
    );
    const left = screen.getByLabelText<HTMLVideoElement>("原片", { selector: "video" });
    setMediaDuration(left, 13.9);
    fireEvent.loadedMetadata(left);
    expect(seen).toEqual([["left", 13.9]]);
  });

  it("一路读不出来：就地红字写明原因，另一路照常", () => {
    const { right } = mount();
    fireEvent.error(right);
    expect(screen.getByRole("alert")).toHaveTextContent("复刻片 v1加载失败");
    expect(right).toHaveClass("border-danger");
  });

  it("元数据还没到：显示「加载中」，播放、逐帧、进度条都不可用", () => {
    render(
      <SyncPlayers
        left={{ label: "原片", src: "/api/templates/t1/reference/video" }}
        right={{ label: "复刻片 v1", src: "/api/productions/p1/video" }}
      />,
    );
    expect(screen.getByText("加载中")).toBeInTheDocument();
    expect(playButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一帧" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "进度" })).toBeDisabled();
  });

  it("焦点在播放器上时空格播放 / 暂停", () => {
    const { left } = mount();
    const group = screen.getByRole("group", { name: "并排播放器" });
    fireEvent.keyDown(group, { key: " " });
    expect(left.paused).toBe(false);
    fireEvent.keyDown(group, { key: " " });
    expect(left.paused).toBe(true);
  });
});

describe("一路坏了 / 起播被拒 / 换片补设置（7.1 第二轮审查 S1-M1 / S1-M2 / Q-M1）", () => {
  it("复刻片读不出来：原片照常能播，进度条跟原片走", async () => {
    const { left, right, user } = mount();
    breakMedia(right);
    await user.click(playButton());
    expect(left.paused).toBe(false);
    expect(right.paused).toBe(true);
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    left.currentTime = 4;
    fireEvent.timeUpdate(left);
    expect(screen.getByText("0:04 / 0:12")).toBeInTheDocument();
  });

  it("复刻片读不出来、原片已经播到尾：再点播放从头播，不会按钮变「暂停」却什么都没播", async () => {
    const { left, right, user } = mount();
    breakMedia(right);
    await user.click(playButton());
    playToEnd(left);
    expect(playButton()).toBeInTheDocument();
    await user.click(playButton());
    expect(left.currentTime).toBe(0);
    expect(left.paused).toBe(false);
  });

  it("原片读不出来：复刻片照常能播，进度条改由复刻片推进", async () => {
    const { left, right, user } = mount();
    breakMedia(left);
    await user.click(playButton());
    expect([left.paused, right.paused]).toEqual([true, false]);
    right.currentTime = 6;
    fireEvent.timeUpdate(right);
    expect(screen.getByText("0:06 / 0:12")).toBeInTheDocument();
  });

  it("一路缓冲中又坏了：缓冲登记跟着清掉，不会一直挂着「缓冲中」", async () => {
    const { right, user } = mount();
    await user.click(playButton());
    starve(right);
    expect(screen.getByText("缓冲中")).toBeInTheDocument();
    breakMedia(right);
    expect(screen.queryByText("缓冲中")).not.toBeInTheDocument();
  });

  it("两路都坏了：只显示两条报错，不再挂「加载中」", () => {
    render(<SyncPlayers left={{ label: "原片", src: "/a" }} right={{ label: "复刻片 v1", src: "/b" }} />);
    breakMedia(screen.getByLabelText<HTMLVideoElement>("原片", { selector: "video" }));
    breakMedia(screen.getByLabelText<HTMLVideoElement>("复刻片 v1", { selector: "video" }));
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.queryByText("加载中")).not.toBeInTheDocument();
  });

  it("暂停着、还没播过时来的 stalled 不登记：点播放照常两路一起播", async () => {
    const { left, right, user } = mount();
    setMediaReadyState(right, 1);
    fireEvent(right, new Event("stalled"));
    expect(screen.queryByText("缓冲中")).not.toBeInTheDocument();
    await user.click(playButton());
    expect([left.paused, right.paused]).toEqual([false, false]);
  });

  it("起播被自动播放策略拒了（NotAllowedError）：两路一起停、按钮回到「播放」，不一播一停", async () => {
    const { left, right, user } = mount();
    rejectNextPlay(right, "NotAllowedError");
    await user.click(playButton());
    await waitFor(() => expect(playButton()).toBeInTheDocument());
    expect([left.paused, right.paused]).toEqual([true, true]);
  });

  it("换片打断了上一次 play()（AbortError）：不当成失败，仍是播放意图", async () => {
    const { left, user } = mount();
    rejectNextPlay(left, "AbortError");
    await user.click(playButton());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
  });

  it("换片后浏览器把倍速、静音重置了：加载出元数据时按当前设置补回", async () => {
    const { right, user } = mount();
    await user.click(within(screen.getByRole("group", { name: "倍速" })).getByRole("button", { name: "2×" }));
    // 真浏览器换 src 时 playbackRate 回到 defaultPlaybackRate、muted 也可能被重置
    right.playbackRate = 1;
    right.muted = false;
    fireEvent.loadedMetadata(right);
    expect(right.playbackRate).toBe(2);
    expect(right.muted).toBe(true);
  });

  it("换片前那一路在缓冲：新片加载出元数据后旧的缓冲登记作废、接着播", async () => {
    const { left, right, user } = mount();
    await user.click(playButton());
    starve(right);
    expect(screen.getByText("缓冲中")).toBeInTheDocument();
    fireEvent.loadedMetadata(right);
    expect(screen.queryByText("缓冲中")).not.toBeInTheDocument();
    expect([left.paused, right.paused]).toEqual([false, false]);
  });

  it("右键不弹浏览器自带的「显示控件 / 循环播放」菜单", () => {
    const { right } = mount();
    expect(fireEvent.contextMenu(right)).toBe(false);
  });
});
