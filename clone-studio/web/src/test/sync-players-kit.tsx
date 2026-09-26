import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SyncPlayers } from "../components/SyncPlayers.js";
import { setMediaDuration, setMediaReadyState } from "./media.js";

/** CMP-004 并排同步播放器用例的公共起手：挂上两路、给时长、派发 loadedmetadata；模拟缓冲与数据回来 */

export function mount(initialAudio?: "left" | "right", lengths: [number, number] = [12, 12.4], fps?: number) {
  const view = render(
    <SyncPlayers
      left={{ label: "原片", src: "/api/templates/t1/reference/video" }}
      right={{ label: "复刻片 v1", src: "/api/productions/p1/video" }}
      initialAudio={initialAudio}
      fps={fps}
    />,
  );
  const left = screen.getByLabelText<HTMLVideoElement>("原片", { selector: "video" });
  const right = screen.getByLabelText<HTMLVideoElement>("复刻片 v1", { selector: "video" });
  // 真浏览器解码出元数据后派发 loadedmetadata；桩里手动给时长再派发
  setMediaDuration(left, lengths[0]);
  setMediaDuration(right, lengths[1]);
  fireEvent.loadedMetadata(left);
  fireEvent.loadedMetadata(right);
  return { left, right, user: userEvent.setup(), view };
}

/** 真浏览器缓冲：数据掉到 HAVE_CURRENT_DATA 再派发 waiting / stalled */
export function starve(v: HTMLVideoElement, evt: "waiting" | "stalled" = "waiting"): void {
  setMediaReadyState(v, 2);
  fireEvent(v, new Event(evt));
}

/** 数据回来：readyState 回到能播，再派发 canplay 之类 */
export function refill(v: HTMLVideoElement, evt: "canplay" | "canplaythrough" | "playing" = "canplay"): void {
  setMediaReadyState(v, 4);
  fireEvent(v, new Event(evt));
}

export const playButton = () => screen.getByRole("button", { name: "播放" });
