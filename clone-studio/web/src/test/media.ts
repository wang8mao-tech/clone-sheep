import { fireEvent } from "@testing-library/react";

/**
 * <video>/<audio> 的假播放状态，setup.ts 的 HTMLMediaElement 补丁读写它。
 * 挂在元素自身的 Symbol 上而不是模块内 WeakMap：setup 与用例各自 import 时拿到的是同一份状态。
 */
interface FakeMediaState {
  paused: boolean;
  currentTime: number;
  duration: number;
  /** HTMLMediaElement.readyState；默认 4（HAVE_ENOUGH_DATA），模拟缓冲时用例调低 */
  readyState: number;
  /** 读不出来了：error 有值，play() 像浏览器那样以 NotSupportedError 拒绝 */
  error: { code: number; message: string } | null;
  /** 下一次 play() 以这个名字的 DOMException 拒绝（自动播放策略 NotAllowedError、换片打断 AbortError） */
  rejectNextPlay: string | null;
}

const KEY = Symbol.for("clone-studio.fake-media");
type WithState = HTMLMediaElement & { [KEY]?: FakeMediaState };

export function mediaStateOf(el: HTMLMediaElement): FakeMediaState {
  const host = el as WithState;
  host[KEY] ??= {
    paused: true,
    currentTime: 0,
    duration: Number.NaN,
    readyState: 4,
    error: null,
    rejectNextPlay: null,
  };
  return host[KEY];
}

/** 用例里给某个 <video> 设时长（真浏览器由解码元数据给出，之后派发 loadedmetadata） */
export function setMediaDuration(el: HTMLMediaElement, seconds: number): void {
  mediaStateOf(el).duration = seconds;
}

/** 数据够不够接着播：2 = HAVE_CURRENT_DATA（缓冲中），3 / 4 = 够了 */
export function setMediaReadyState(el: HTMLMediaElement, state: number): void {
  mediaStateOf(el).readyState = state;
}

/** 这一路读不出来（404 / 格式不认）：设上 error 并派发 error 事件 */
export function breakMedia(el: HTMLMediaElement, message = "MEDIA_ELEMENT_ERROR: Format error"): void {
  mediaStateOf(el).error = { code: 4, message };
  fireEvent.error(el);
}

/** 下一次 play() 被拒 */
export function rejectNextPlay(el: HTMLMediaElement, name: "NotAllowedError" | "AbortError"): void {
  mediaStateOf(el).rejectNextPlay = name;
}

/** 真浏览器播到尾：停下并派发 ended（桩不会自己推进时间） */
export function playToEnd(el: HTMLMediaElement): void {
  const s = mediaStateOf(el);
  s.currentTime = s.duration;
  s.paused = true;
  // 走 fireEvent：包在 act() 里，React 的状态更新当场生效
  fireEvent.pause(el);
  fireEvent.ended(el);
}
