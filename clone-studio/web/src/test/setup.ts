import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { mediaStateOf as stateOf } from "./media.js";

/**
 * jsdom 的补丁层。
 *
 * jsdom 30 实测缺这几样：HTMLDialogElement.showModal / EventSource /
 * matchMedia / scrollIntoView。下面是补丁，不是真实现——**补丁覆盖到的行为
 * 不算被测过**：弹窗真正的模态性、焦点陷阱、Esc 关闭都由浏览器负责，
 * 这里只能验"该开的时候开了、该拿到的回调拿到了"。真模态行为要靠真机看。
 */

// ── <dialog>：jsdom 不实现 showModal/close，只好自己维护 open 属性 ──
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, returnValue?: string): void {
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event("close"));
  };
}

// ── matchMedia：DesktopOnlyGate 拿它判视口。默认回 false＝视口够宽，
//    组件测试才不会被那道闸门挡在外面 ──
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

// ── EventSource：useSse 会 new 一个。这里只给个不连接的空壳，
//    SSE 的真实行为（断线重连、补发）不在组件测试的射程内 ──
if (typeof globalThis.EventSource === "undefined") {
  class FakeEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly readyState = 0;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onopen: ((e: Event) => void) | null = null;
    constructor(readonly url: string) {
      super();
    }
    close(): void {}
  }
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
}

// ── HTMLMediaElement：jsdom 的 play/pause 只报「未实现」，paused 永远是 true，
//    duration 永远是 NaN。这里用一份每元素的假状态（test/media.ts）顶上：play/pause 翻 paused 并派发同名事件，
//    currentTime 可读写，duration 由用例用 setMediaDuration 设。**没有真解码**：
//    缓冲（readyState）、时间推进、播到尾都得用例自己设 / fireEvent（test/media.ts 有帮手），桩只保证状态读写前后一致 ──
if (typeof HTMLMediaElement !== "undefined") {
  const proto = HTMLMediaElement.prototype;
  proto.play = function play(this: HTMLMediaElement): Promise<void> {
    const s = stateOf(this);
    if (s.error) return Promise.reject(new DOMException("The element has no supported sources.", "NotSupportedError"));
    if (s.rejectNextPlay) {
      const name = s.rejectNextPlay;
      s.rejectNextPlay = null;
      return Promise.reject(new DOMException(`play() rejected (${name})`, name));
    }
    if (s.paused) {
      s.paused = false;
      this.dispatchEvent(new Event("play"));
    }
    return Promise.resolve();
  };
  proto.pause = function pause(this: HTMLMediaElement): void {
    const s = stateOf(this);
    if (!s.paused) {
      s.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  };
  proto.load = function load(): void {};
  Object.defineProperty(proto, "paused", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).paused;
    },
  });
  Object.defineProperty(proto, "duration", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).duration;
    },
  });
  Object.defineProperty(proto, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).currentTime;
    },
    set(this: HTMLMediaElement, v: number) {
      const { duration } = stateOf(this);
      stateOf(this).currentTime = Math.max(0, Number.isFinite(duration) ? Math.min(v, duration) : v);
    },
  });
  Object.defineProperty(proto, "error", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).error;
    },
  });
  Object.defineProperty(proto, "readyState", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).readyState;
    },
  });
  Object.defineProperty(proto, "ended", {
    configurable: true,
    get(this: HTMLMediaElement) {
      const { currentTime, duration } = stateOf(this);
      return Number.isFinite(duration) && currentTime >= duration;
    },
  });
  // playbackRate / muted jsdom 自己就能读写，不用补
}

if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
