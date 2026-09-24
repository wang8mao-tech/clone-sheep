import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SyncPlayers } from "./SyncPlayers.js";
import { setMediaDuration } from "../test/media.js";

/** CMP-004 并排同步播放器：拖动 / 倍速 / 缓冲联动 / 声音来源 / 逐帧（REQ-004、AC-011） */

function mount(initialAudio?: "left" | "right") {
  render(
    <SyncPlayers
      left={{ label: "原片", src: "/api/templates/t1/reference/video" }}
      right={{ label: "复刻片 v1", src: "/output/clone-v1.mp4" }}
      initialAudio={initialAudio}
    />,
  );
  const left = screen.getByLabelText<HTMLVideoElement>("原片", { selector: "video" });
  const right = screen.getByLabelText<HTMLVideoElement>("复刻片 v1", { selector: "video" });
  // 真浏览器解码出元数据后派发 loadedmetadata；桩里手动给时长再派发
  setMediaDuration(left, 12);
  setMediaDuration(right, 12.4);
  fireEvent.loadedMetadata(left);
  fireEvent.loadedMetadata(right);
  return { left, right, user: userEvent.setup() };
}

const playButton = () => screen.getByRole("button", { name: "播放" });

describe("拖动进度条", () => {
  it("两路跳到同一时间点，误差 ≤0.2 秒", () => {
    const { left, right } = mount();
    fireEvent.change(screen.getByRole("slider", { name: "进度" }), { target: { value: "7.35" } });
    expect(left.currentTime).toBeCloseTo(7.35, 5);
    expect(Math.abs(left.currentTime - right.currentTime)).toBeLessThanOrEqual(0.2);
    expect(screen.getByText("0:07 / 0:12")).toBeInTheDocument();
  });

  it("播放中右路漂出 0.2 秒以上，下一次 timeupdate 被拉回左路", async () => {
    const { left, right, user } = mount();
    await user.click(playButton());
    left.currentTime = 3;
    right.currentTime = 3.5;
    fireEvent.timeUpdate(left);
    expect(right.currentTime).toBe(3);
  });
});

describe("播放 / 暂停 / 倍速", () => {
  it("播放、暂停两路一致", async () => {
    const { left, right, user } = mount();
    await user.click(playButton());
    expect([left.paused, right.paused]).toEqual([false, false]);
    await user.click(screen.getByRole("button", { name: "暂停" }));
    expect([left.paused, right.paused]).toEqual([true, true]);
  });

  it.each([1.5, 2, 1])("切到 %s× 两路 playbackRate 一致", async (rate) => {
    const { left, right, user } = mount();
    const group = screen.getByRole("group", { name: "倍速" });
    const button = Array.from(group.querySelectorAll("button")).find((b) => b.textContent === `${rate}×`);
    await user.click(button as HTMLButtonElement);
    expect(left.playbackRate).toBe(rate);
    expect(right.playbackRate).toBe(rate);
    expect(button).toHaveAttribute("aria-pressed", "true");
  });
});

describe("任一路缓冲", () => {
  it.each(["waiting", "stalled"] as const)("一路 %s 两路暂停，canplay 后按原状态恢复", async (evt) => {
    const { left, right, user } = mount();
    await user.click(playButton());

    fireEvent(right, new Event(evt));
    expect([left.paused, right.paused]).toEqual([true, true]);
    expect(screen.getByText("缓冲中")).toBeInTheDocument();
    // 用户意图仍是播放：按钮还显示「暂停」
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();

    fireEvent.canPlay(right);
    expect([left.paused, right.paused]).toEqual([false, false]);
    expect(screen.queryByText("缓冲中")).not.toBeInTheDocument();
  });

  it("两路都在缓冲时，要等两路都 canplay 才恢复", async () => {
    const { left, right, user } = mount();
    await user.click(playButton());
    fireEvent.waiting(left);
    fireEvent.waiting(right);
    fireEvent.canPlay(left);
    expect([left.paused, right.paused]).toEqual([true, true]);
    fireEvent.canPlay(right);
    expect([left.paused, right.paused]).toEqual([false, false]);
  });

  it("缓冲前是暂停的，canplay 后仍保持暂停", () => {
    const { left, right } = mount();
    fireEvent.waiting(left);
    fireEvent.canPlay(left);
    expect([left.paused, right.paused]).toEqual([true, true]);
    expect(playButton()).toBeInTheDocument();
  });
});

describe("声音来源", () => {
  it("默认只开左路（原片）声", () => {
    const { left, right } = mount();
    expect([left.muted, right.muted]).toEqual([false, true]);
    const group = screen.getByRole("group", { name: "声音来源" });
    expect(group.querySelector('[aria-pressed="true"]')).toHaveTextContent("原片");
  });

  it("切到复刻片后只开右路", async () => {
    const { left, right, user } = mount();
    const group = screen.getByRole("group", { name: "声音来源" });
    const toRight = Array.from(group.querySelectorAll("button")).find((b) => b.textContent === "复刻片 v1");
    await user.click(toRight as HTMLButtonElement);
    expect([left.muted, right.muted]).toEqual([true, false]);
  });

  it("initialAudio=right 时默认只开右路", () => {
    const { left, right } = mount("right");
    expect([left.muted, right.muted]).toEqual([true, false]);
  });
});

describe("逐帧", () => {
  it("前后键按 1/30 秒步进，两路同步并停下", async () => {
    const { left, right, user } = mount();
    fireEvent.change(screen.getByRole("slider", { name: "进度" }), { target: { value: "2" } });
    await user.click(playButton());

    await user.click(screen.getByRole("button", { name: "下一帧" }));
    expect(left.currentTime).toBeCloseTo(2 + 1 / 30, 6);
    expect(right.currentTime).toBeCloseTo(2 + 1 / 30, 6);
    expect([left.paused, right.paused]).toEqual([true, true]);

    await user.click(screen.getByRole("button", { name: "上一帧" }));
    await user.click(screen.getByRole("button", { name: "上一帧" }));
    expect(left.currentTime).toBeCloseTo(2 - 1 / 30, 6);
    expect(right.currentTime).toBeCloseTo(2 - 1 / 30, 6);
  });

  it("键盘 , . 同样逐帧，0 秒处不再往前", () => {
    const { left } = mount();
    const group = screen.getByRole("group", { name: "并排播放器" });
    fireEvent.keyDown(group, { key: "." });
    expect(left.currentTime).toBeCloseTo(1 / 30, 6);
    fireEvent.keyDown(group, { key: "," });
    fireEvent.keyDown(group, { key: "," });
    expect(left.currentTime).toBe(0);
  });
});

describe("布局", () => {
  it("两片等高、按 9:16 适配、object-contain 不拉伸", () => {
    const { left, right } = mount();
    for (const v of [left, right]) {
      expect(v).toHaveClass("aspect-[9/16]", "object-contain", "w-auto");
      expect(v).not.toHaveAttribute("controls");
    }
    expect(left.className).toBe(right.className);
  });
});
