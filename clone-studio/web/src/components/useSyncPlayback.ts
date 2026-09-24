import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

export type Side = "left" | "right";

/** 倍速档位（REQ-004：两路倍速一致） */
export const RATES = [1, 1.5, 2] as const;
export type Rate = (typeof RATES)[number];

/** 逐帧步长：按 30 fps 算一帧（CMP-004） */
export const FRAME_SECONDS = 1 / 30;

/** 两路漂移超过这个值就把右路拉回左路（AC-011：误差 ≤0.2 秒） */
const MAX_DRIFT = 0.2;

const SIDES: readonly Side[] = ["left", "right"];

/**
 * CMP-004 并排同步播放器的播放状态机。左路是主时钟，右路跟随。
 *
 * - `intent` 是用户想要的播放状态；任一路缓冲（waiting/stalled）时两路被动暂停，
 *   但 intent 不变，等缓冲的那几路都 canplay 了再按 intent 恢复。
 * - 倍速、声音来源由 effect 下发到元素上；换片（src 变了）重新加载后在 loadedmetadata 里补一次。
 */
export function useSyncPlayback(initialAudio: Side) {
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

  const each = useCallback((fn: (v: HTMLVideoElement, side: Side) => void): void => {
    for (const side of SIDES) {
      const v = (side === "left" ? left : right).current;
      if (v) fn(v, side);
    }
  }, []);

  const pauseBoth = useCallback((): void => each((v) => v.pause()), [each]);

  const playBoth = useCallback((): void => {
    const master = left.current;
    each((v) => {
      // 起播前对齐一次：缓冲恢复时两路进度可能已经分开
      if (master && v !== master && Math.abs(v.currentTime - master.currentTime) > MAX_DRIFT) {
        v.currentTime = master.currentTime;
      }
      // 较短的那路已经播完就停在末帧，不从头重播
      if (v.ended) return;
      v.play().catch(() => {
        // 换片中途被打断或被自动播放策略拦截：界面仍按用户意图显示，再点一次即可
      });
    });
  }, [each]);

  const setIntent = useCallback((next: boolean): void => {
    intent.current = next;
    setPlaying(next);
  }, []);

  const seek = useCallback(
    (t: number): void => {
      const target = Math.max(0, duration > 0 ? Math.min(t, duration) : t);
      each((v) => {
        v.currentTime = target;
      });
      setTime(target);
    },
    [duration, each],
  );

  const toggle = useCallback((): void => {
    if (intent.current) {
      setIntent(false);
      pauseBoth();
      return;
    }
    const allEnded = [left.current, right.current].every((v) => !v || v.ended);
    if (allEnded) seek(0);
    setIntent(true);
    if (stalled.current.size === 0) playBoth();
  }, [pauseBoth, playBoth, seek, setIntent]);

  /** 逐帧：先停，再以左路当前时间为基准走一帧 */
  const step = useCallback(
    (dir: -1 | 1): void => {
      setIntent(false);
      pauseBoth();
      seek((left.current?.currentTime ?? time) + dir * FRAME_SECONDS);
    },
    [pauseBoth, seek, setIntent, time],
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

  const handlers = useCallback(
    (side: Side) => {
      const onStall = (): void => {
        stalled.current.add(side);
        setBuffering(true);
        pauseBoth();
      };
      return {
        onWaiting: onStall,
        onStalled: onStall,
        onCanPlay: (): void => {
          if (!stalled.current.delete(side) || stalled.current.size > 0) return;
          setBuffering(false);
          if (intent.current) playBoth();
        },
        onLoadedMetadata: (e: SyntheticEvent<HTMLVideoElement>): void => {
          const v = e.currentTarget;
          v.playbackRate = rate;
          v.muted = side !== audio;
          if (side === "right" && left.current) v.currentTime = left.current.currentTime;
          const lengths = [left.current?.duration, right.current?.duration].filter(
            (d): d is number => typeof d === "number" && Number.isFinite(d),
          );
          setDuration(lengths.length > 0 ? Math.max(...lengths) : 0);
        },
        onTimeUpdate: (e: SyntheticEvent<HTMLVideoElement>): void => {
          const v = e.currentTarget;
          const follower = right.current;
          // 主时钟是左路；左路较短、先播完后改由右路推进进度条
          if (side === "left" || left.current?.ended) setTime(v.currentTime);
          if (side === "left" && follower && !follower.ended && !v.paused) {
            if (Math.abs(follower.currentTime - v.currentTime) > MAX_DRIFT) follower.currentTime = v.currentTime;
          }
        },
        onEnded: (): void => {
          const allDone = [left.current, right.current].every((v) => !v || v.ended || v.paused);
          if (allDone) setIntent(false);
        },
      };
    },
    [audio, pauseBoth, playBoth, rate, setIntent],
  );

  return {
    left,
    right,
    playing,
    time,
    duration,
    rate,
    audio,
    buffering,
    toggle,
    seek,
    step,
    setRate,
    setAudio,
    handlers,
  };
}
