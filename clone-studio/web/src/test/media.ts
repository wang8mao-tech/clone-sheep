/**
 * <video>/<audio> 的假播放状态，setup.ts 的 HTMLMediaElement 补丁读写它。
 * 挂在元素自身的 Symbol 上而不是模块内 WeakMap：setup 与用例各自 import 时拿到的是同一份状态。
 */
interface FakeMediaState {
  paused: boolean;
  currentTime: number;
  duration: number;
}

const KEY = Symbol.for("clone-studio.fake-media");
type WithState = HTMLMediaElement & { [KEY]?: FakeMediaState };

export function mediaStateOf(el: HTMLMediaElement): FakeMediaState {
  const host = el as WithState;
  host[KEY] ??= { paused: true, currentTime: 0, duration: Number.NaN };
  return host[KEY];
}

/** 用例里给某个 <video> 设时长（真浏览器由解码元数据给出，之后派发 loadedmetadata） */
export function setMediaDuration(el: HTMLMediaElement, seconds: number): void {
  mediaStateOf(el).duration = seconds;
}
