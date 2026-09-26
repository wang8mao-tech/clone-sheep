import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

export type Side = "left" | "right";

/** 倍速档位（REQ-004：两路倍速一致） */
export const RATES = [1, 1.5, 2] as const;
export type Rate = (typeof RATES)[number];

/** 两路漂移超过这个值就把跟随的那路拉回主时钟（AC-011：误差 ≤0.2 秒） */
const MAX_DRIFT = 0.2;
/** 离时长还差这么多就算「到尾了」：浏览器 ended 在拖回去之前一直是真，不能靠它判断 */
const END_EPSILON = 0.05;
/** HTMLMediaElement.HAVE_FUTURE_DATA：到这一级就能接着播，不算缓冲 */
const HAVE_FUTURE_DATA = 3;

const SIDES: readonly Side[] = ["left", "right"];

const atEnd = (v: HTMLVideoElement): boolean =>
  Number.isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - END_EPSILON;

/** 一路加载出元数据后报给页面：③ 验货的时长差、分辨率差由它算（SCREEN-005） */
export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
}

/** 这一路读不出来了（404、格式不认）：不再对它 play()，也不拿它当主时钟 */
const broken = (v: HTMLVideoElement): boolean => v.error !== null;

/**
 * CMP-004 并排同步播放器的播放状态机。
 *
 * - `intent` 是用户想要的播放状态。任一路缓冲（waiting / 数据真的不够的 stalled）两路被动暂停，intent 不变；
 *   那一路一旦 canplay / canplaythrough / playing（或点播放时它其实已经够数据了）就解除，全部解除后按 intent 恢复。
 * - 主时钟是还没播到尾的那一路（默认左路）：进度条跟它走，另一路漂移超过 0.2 秒就拉回。两片时长不一样时，
 *   短的先到尾停在末帧；拖回去（或逐帧）后只要 intent 是播放，没到尾的那几路都会重新播起来。
 * - 倍速、声音来源由 effect 下发；换片（src 变了）加载出元数据后补一次，intent 是播放就接着播。
 * - 起播被浏览器拒了（自动播放策略之类）：两路一起停、intent 置回暂停，不让两路一播一停地错开。
 * - 一路读不出来（error）：那一路就地报错、不再参与，另一路照常能播、进度条跟它走（7.1 第二轮审查 S1-M1）。
 * - 暂停着、还没播过时来的 waiting / stalled 不登记：preload=metadata 下没 play() 浏览器不会再取数据，
 *   也就不会再来 canplay，登记了就永远解不开（S1-M2）。
 */

export function useSyncPlayback(initialAudio: Side, fps: number, onMeta?: (side: Side, meta: VideoMeta) => void) {
  const left = useRef<HTMLVideoElement>(null);
  const right = useRef<HTMLVideoElement>(null);
  const intent = useRef(false);
  const stalled = useRef(new Set<Side>());

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<Rate>(1);
  const [audio, setAudio] = useState<Side>(initialAudio);
  const [buffering, setBuffering] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Side, string>>>({});

  const each = useCallback((fn: (v: HTMLVideoElement, side: Side) => void): void => {
    for (const side of SIDES) {
      const v = (side === "left" ? left : right).current;
      if (v) fn(v, side);
    }
  }, []);

  /** 主时钟：左路能用且没到尾就是左路，否则右路（右路也坏了就还是左路，进度条不动） */
  const master = useCallback((): HTMLVideoElement | null => {
    const l = left.current;
    const r = right.current;
    if (l && !broken(l) && !atEnd(l)) return l;
    return r && !broken(r) ? r : l;
  }, []);

  const setIntent = useCallback((next: boolean): void => {
    intent.current = next;
    setPlaying(next);
  }, []);

  const pauseBoth = useCallback((): void => each((v) => v.pause()), [each]);

  /** 缓冲登记里清掉其实已经够数据的那几路（stalled 事件在 Chromium 上会误报，也不一定跟着 canplay） */
  const pruneStalled = useCallback((): void => {
    for (const side of [...stalled.current]) {
      const v = (side === "left" ? left : right).current;
      if (!v || v.readyState >= HAVE_FUTURE_DATA) stalled.current.delete(side);
    }
    if (stalled.current.size === 0) setBuffering(false);
  }, []);

  const playBoth = useCallback((): void => {
    const clock = master();
    each((v) => {
      // 起播前对齐一次：缓冲恢复、拖动之后两路进度可能已经分开
      if (clock && v !== clock && !atEnd(v) && Math.abs(v.currentTime - clock.currentTime) > MAX_DRIFT) {
        v.currentTime = clock.currentTime;
      }
      // 已经播到尾的那路停在末帧，不从头重播；读不出来的那路不管它
      if (broken(v) || atEnd(v) || !v.paused) return;
      v.play().catch((error: unknown) => {
        // 换片打断上一次 play() 是正常的（AbortError）；那一路自己坏了（error 事件会报）也不拖累另一路；
        // 别的拒绝（自动播放策略）两路一起停，别错开
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (broken(v)) return;
        intent.current = false;
        setPlaying(false);
        each((x) => x.pause());
      });
    });
  }, [each, master]);

  /** intent 是播放且没有在缓冲：把该播的都播起来 */
  const resume = useCallback((): void => {
    pruneStalled();
    if (intent.current && stalled.current.size === 0) playBoth();
  }, [playBoth, pruneStalled]);

  const seek = useCallback(
    (t: number): void => {
      const target = Math.max(0, duration > 0 ? Math.min(t, duration) : t);
      each((v) => {
        v.currentTime = target;
      });
      setTime(target);
      // 短的那路到尾停了、拖回去之后要让它跟上
      resume();
    },
    [duration, each, resume],
  );

  const toggle = useCallback((): void => {
    if (intent.current) {
      setIntent(false);
      pauseBoth();
      return;
    }
    // 读不出来的那路不算：另一路播到尾了就从头播（7.1 第三轮审查 S1-M1r3）
    const usable = [left.current, right.current].filter((v): v is HTMLVideoElement => v !== null && !broken(v));
    setIntent(true);
    if (usable.length > 0 && usable.every(atEnd)) seek(0);
    else resume();
  }, [pauseBoth, resume, seek, setIntent]);

  /** 逐帧：先停，再以主时钟当前时间为基准走一帧 */
  const step = useCallback(
    (dir: -1 | 1): void => {
      setIntent(false);
      pauseBoth();
      seek((master()?.currentTime ?? time) + dir / fps);
    },
    [fps, master, pauseBoth, seek, setIntent, time],
  );

  useEffect(() => {
    each((v) => {
      v.playbackRate = rate;
    });
  }, [each, rate]);

  useEffect(() => {
    each((v, side) => {
      v.muted = side !== audio;
    });
  }, [each, audio]);

  const handlers = (side: Side) => {
    const ready = (): void => {
      if (!stalled.current.delete(side)) return;
      if (stalled.current.size === 0) {
        setBuffering(false);
        if (intent.current) playBoth();
      }
    };
    const stall = (e: SyntheticEvent<HTMLVideoElement>): void => {
      // stalled 在数据其实够的时候也会来（Chromium 误报），够数据就不当缓冲；没打算播时也不当（S1-M2）
      if (e.currentTarget.readyState >= HAVE_FUTURE_DATA || !intent.current) return;
      stalled.current.add(side);
      setBuffering(true);
      pauseBoth();
    };
    return {
      onWaiting: stall,
      onStalled: stall,
      onCanPlay: ready,
      onCanPlayThrough: ready,
      onPlaying: ready,
      onError: (e: SyntheticEvent<HTMLVideoElement>): void => {
        const err = e.currentTarget.error;
        setErrors((prev) => ({ ...prev, [side]: err?.message || `读不到这个视频（错误码 ${err?.code ?? "未知"}）` }));
        stalled.current.delete(side);
        if (stalled.current.size === 0) setBuffering(false);
      },
      onLoadedMetadata: (e: SyntheticEvent<HTMLVideoElement>): void => {
        const v = e.currentTarget;
        setErrors((prev) => ({ ...prev, [side]: undefined }));
        v.playbackRate = rate;
        v.muted = side !== audio;
        // 换片：新的一路对齐到另一路的进度；上一片留下的缓冲登记作废
        const other = side === "left" ? right.current : left.current;
        if (other && Number.isFinite(other.currentTime)) v.currentTime = Math.min(other.currentTime, v.duration);
        stalled.current.delete(side);
        const lengths = [left.current?.duration, right.current?.duration].filter(
          (d): d is number => typeof d === "number" && Number.isFinite(d),
        );
        setDuration(lengths.length > 0 ? Math.max(...lengths) : 0);
        onMeta?.(side, { duration: v.duration, width: v.videoWidth, height: v.videoHeight });
        resume();
      },
      onTimeUpdate: (e: SyntheticEvent<HTMLVideoElement>): void => {
        const v = e.currentTarget;
        const clock = master();
        if (v !== clock) return;
        setTime(v.currentTime);
        if (v.paused) return;
        const follower = v === left.current ? right.current : left.current;
        if (
          follower &&
          !atEnd(follower) &&
          !follower.paused &&
          Math.abs(follower.currentTime - v.currentTime) > MAX_DRIFT
        ) {
          follower.currentTime = v.currentTime;
        }
      },
      onEnded: (): void => {
        const all = [left.current, right.current].filter((x): x is HTMLVideoElement => x !== null);
        if (all.every((x) => atEnd(x) || x.paused)) setIntent(false);
        // 另一路还在播：进度条改由它推进（master() 已经换过去了）
      },
      onContextMenu: (e: SyntheticEvent): void => {
        // 右键的「显示控件 / 循环播放」会绕开共享控制条，两路就不同步了
        e.preventDefault();
      },
    };
  };

  return {
    left,
    right,
    playing,
    time,
    duration,
    rate,
    audio,
    buffering,
    errors,
    loaded: duration > 0,
    toggle,
    seek,
    step,
    setRate,
    setAudio,
    handlers,
  };
}
