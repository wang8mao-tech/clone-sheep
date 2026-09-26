import type { KeyboardEvent, ReactNode } from "react";
import { Pause, Play, StepBack, StepForward } from "lucide-react";
import { Badge } from "./ui/Badge.js";
import { Button } from "./ui/Button.js";
import { formatDuration } from "../lib/run-elapsed.js";
import { RATES, useSyncPlayback, type Side, type VideoMeta } from "./useSyncPlayback.js";

export interface SyncSource {
  /** 播放器上方的名字：「原片」「复刻片 v2」 */
  label: string;
  src: string;
}

interface Props {
  left: SyncSource;
  right: SyncSource;
  /** 默认只开哪一路的声音；REQ-004 规定默认原片（左） */
  initialAudio?: Side;
  /** 逐帧的帧率（参考视频探测出来的 fps）；不给按 30 */
  fps?: number;
  /** 每一路加载出元数据后回报时长与分辨率（页面算两片的差） */
  onMeta?: (side: Side, meta: VideoMeta) => void;
}

/**
 * CMP-004 并排同步播放器（SCREEN-005 ③验货，REQ-004 / AC-011）。
 *
 * 两路 <video> 不带原生控制条，共享下方一条进度条与控制：播放/暂停、拖动、倍速两路一致；
 * 逐帧前后（按钮或 `,` `.` 键，一步一帧，帧率由 fps 给）；声音来源二选一；任一路缓冲两路一起停。
 * 9:16 竖屏按高度适配，两片等高，object-contain 留黑边不拉伸（Design-Brief 5.5）。
 * 键盘：焦点在播放器里时空格播放 / 暂停，`,` `.` 逐帧；进度条方向键一步一帧。
 * 任一路读不出来就地红字写明原因（§6.2 错误），另一路照常能看；元数据没到之前显示「加载中」、控制不可用。
 */
export function SyncPlayers({ left, right, initialAudio = "left", fps = 30, onMeta }: Props) {
  const p = useSyncPlayback(initialAudio, fps > 0 ? fps : 30, onMeta);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === ",") p.step(-1);
    else if (e.key === ".") p.step(1);
    // 空格只在焦点落在播放器外框上时接管：落在按钮上时浏览器自己会「点」一下按钮
    else if (e.key === " " && e.target === e.currentTarget) p.toggle();
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="group"
      aria-label="并排播放器"
      tabIndex={0}
      className="mx-auto flex w-fit max-w-full flex-col gap-md rounded-md focus-visible:outline-2 focus-visible:outline-primary"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-start justify-center gap-lg">
        {(["left", "right"] as const).map((side) => {
          const source = side === "left" ? left : right;
          return (
            <figure key={side} className="m-0 flex flex-col gap-xs">
              <figcaption className="text-caption text-text-secondary">{source.label}</figcaption>
              <video
                ref={side === "left" ? p.left : p.right}
                aria-label={source.label}
                src={source.src}
                preload="metadata"
                playsInline
                {...p.handlers(side)}
                className={[
                  "aspect-[9/16] h-[clamp(320px,60vh,640px)] w-auto rounded-md border bg-black object-contain",
                  p.errors[side] ? "border-danger" : "border-border",
                ].join(" ")}
              />
              {p.errors[side] ? (
                <p role="alert" className="max-w-[360px] text-caption text-danger">
                  {source.label}加载失败：<span className="font-mono">{p.errors[side]}</span>
                </p>
              ) : null}
            </figure>
          );
        })}
      </div>

      <input
        type="range"
        aria-label="进度"
        min={0}
        max={p.duration || 0}
        step={1 / (fps > 0 ? fps : 30)}
        value={p.time}
        disabled={!p.loaded}
        onChange={(e) => p.seek(Number(e.currentTarget.value))}
        className="w-full accent-primary disabled:opacity-40"
      />

      <div className="flex flex-wrap items-center gap-sm">
        <Button
          variant="secondary"
          aria-label={p.playing ? "暂停" : "播放"}
          icon={p.playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
          onClick={p.toggle}
          disabled={!p.loaded}
          className="w-8 px-0"
        />
        <Button
          variant="ghost"
          aria-label="上一帧"
          title="上一帧（,）"
          icon={<StepBack aria-hidden className="size-4" />}
          onClick={() => p.step(-1)}
          disabled={!p.loaded}
          className="w-8 px-0"
        />
        <Button
          variant="ghost"
          aria-label="下一帧"
          title="下一帧（.）"
          icon={<StepForward aria-hidden className="size-4" />}
          onClick={() => p.step(1)}
          disabled={!p.loaded}
          className="w-8 px-0"
        />
        <span className="font-mono text-caption text-text-secondary tabular-nums">
          {formatDuration(p.time * 1000)} / {formatDuration(p.duration * 1000)}
        </span>
        {!p.loaded && !p.errors.left && !p.errors.right ? (
          <Badge tone="neutral">加载中</Badge>
        ) : p.buffering ? (
          <Badge tone="info">缓冲中</Badge>
        ) : null}

        <Segmented label="倍速" className="ml-auto">
          {RATES.map((r) => (
            <Choice key={r} pressed={p.rate === r} onClick={() => p.setRate(r)} mono>
              {r}×
            </Choice>
          ))}
        </Segmented>
        <Segmented label="声音来源">
          {(["left", "right"] as const).map((side) => (
            <Choice key={side} pressed={p.audio === side} onClick={() => p.setAudio(side)}>
              {(side === "left" ? left : right).label}
            </Choice>
          ))}
        </Segmented>
      </div>
    </div>
  );
}

function Segmented({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className={`flex items-center gap-xs ${className}`}>
      <span className="text-caption text-text-tertiary">{label}</span>
      {children}
    </div>
  );
}

function Choice({
  pressed,
  onClick,
  mono = false,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant={pressed ? "secondary" : "ghost"}
      aria-pressed={pressed}
      onClick={onClick}
      className={`px-2 ${mono ? "font-mono tabular-nums" : ""}`}
    >
      {children}
    </Button>
  );
}
