import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { TimelineItem } from "../../lib/agent-timeline.js";
import { toneOf } from "../../lib/agent-timeline.js";
import { describeStop } from "../../lib/agent-status.js";
import { formatDuration } from "../../lib/run-elapsed.js";
import { Markdown } from "./Markdown.js";
import { ToneBlock } from "./ToneBlock.js";
import { ToolRow } from "./ToolRow.js";
import { useTypewriter } from "./useTypewriter.js";

interface Props {
  items: TimelineItem[];
  /** seq 大于它的是打开抽屉后才到的：逐字流式 */
  liveAfterSeq: number;
  /** 任务正在跑（决定工具行转圈、「思考中」） */
  running: boolean;
  /** 最后一条消息的时间：「思考中」从它开始计时 */
  lastAt: string | null;
  now: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}

/** 离底部这么近就算「贴着底」：新消息来了跟着滚；往上翻着看历史时不打扰 */
const STICK_PX = 48;

/**
 * 会话流（Design-Brief §A.2 / §A.3）。整份按 items 渲染，不在这里累积状态。
 * 贴底时新内容来了自动滚到底；往上翻着看时不抢滚动条。
 */
export function MessageStream({
  items,
  liveAfterSeq,
  running,
  lastAt,
  now,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const last = items.at(-1);
  const pendingTool = last?.kind === "tool" && !last.result;
  // 跑着、又不在跑工具：模型在想（Design-Brief §A.3「思考中」：一行脉动文字 + 计时）
  const thinking = running && !pendingTool;

  // 只在内容真的往下长时跟到底：新消息、逐字流式。别每次渲染都跟——秒表每秒重渲染一次，
  // 贴底时展开上面的工具行会被立刻拽回底部，刚点开的东西就看不见了
  const follow = useCallback(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(follow, [items, thinking, follow]);

  return (
    <div
      ref={scroller}
      role="log"
      aria-label="Agent 会话流"
      onScroll={(e) => {
        const el = e.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      }}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
    >
      {hasOlder ? (
        <button
          type="button"
          disabled={loadingOlder}
          onClick={onLoadOlder}
          className="min-h-7 self-center text-caption text-text-tertiary hover:text-text disabled:opacity-40"
        >
          {loadingOlder ? "加载中…" : "加载更早的消息"}
        </button>
      ) : null}
      {items.map((item) => (
        <Item key={item.key} item={item} live={item.seq > liveAfterSeq} running={running} now={now} onGrow={follow} />
      ))}
      {thinking ? (
        <div className="animate-pulse text-text-tertiary">
          思考中 · {formatDuration(lastAt ? now - Date.parse(lastAt) : 0)}
        </div>
      ) : null}
    </div>
  );
}

function Item({
  item,
  live,
  running,
  now,
  onGrow,
}: {
  item: TimelineItem;
  live: boolean;
  running: boolean;
  now: number;
  onGrow: () => void;
}) {
  switch (item.kind) {
    case "prompt":
      return <Prompt text={item.text} />;
    case "stopped":
      return <div className="text-caption text-text-tertiary">— 会话在这里被停下：{stopLabel(item.reason)} —</div>;
    case "divider":
      return (
        <div role="separator" className="flex items-center gap-2 py-1 text-caption text-text-tertiary">
          <span className="h-px flex-1 bg-border" />
          {item.label}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "text":
      return <AssistantText text={item.text} live={live} onGrow={onGrow} />;
    case "thinking":
      return <Thinking text={item.text} seconds={item.seconds} />;
    case "tool":
      return <ToolRow item={item} running={running} now={now} />;
    case "intercept":
      return (
        <ToneBlock tone={toneOf(item)}>
          <div className="text-warning">{item.rule === "hypit-command" ? "已拦截：出片由宿主负责" : "已拦截"}</div>
          <div className="truncate text-text-secondary" title={item.detail}>
            {item.tool} · {item.detail}
          </div>
          <div className="text-caption whitespace-pre-wrap text-text-tertiary">{item.reason}</div>
        </ToneBlock>
      );
    case "error":
      return (
        <ToneBlock tone={toneOf(item)}>
          <div className="text-danger">{item.title}</div>
          <pre className="text-caption whitespace-pre-wrap text-text-secondary">{item.detail}</pre>
        </ToneBlock>
      );
  }
}

function AssistantText({ text, live, onGrow }: { text: string; live: boolean; onGrow: () => void }) {
  const { shown, typing } = useTypewriter(text, live);
  useLayoutEffect(onGrow, [shown, onGrow]);
  return <Markdown text={shown} cursor={typing} />;
}

/** 宿主停下这一段的原因，和结束卡同一套说法；限流单说 */
function stopLabel(reason: string): string {
  if (reason === "awaiting_quota") return "额度受限，等恢复后续跑";
  return describeStop({ status: "interrupted", stopReason: reason }) || "宿主停下";
}

/** 超过这么多行的任务提示先收起：完整的任务提示很长，一上来占满半个抽屉 */
const PROMPT_LINES = 4;

/** 系统代发的任务提示 / 继续 / 打回意见：左侧细竖线 + 次级文字色（Design-Brief §A.2） */
function Prompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > PROMPT_LINES;
  return (
    <div className="border-l-2 border-border pl-2 text-text-secondary">
      <div className="whitespace-pre-wrap">{long && !open ? lines.slice(0, PROMPT_LINES).join("\n") : text}</div>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-h-7 text-caption text-text-tertiary hover:text-text"
        >
          {open ? "收起" : `展开全部 ${lines.length} 行`}
        </button>
      ) : null}
    </div>
  );
}

/** 思考默认折叠成一行「思考 · 8s」，点开看全文（Design-Brief §A.2 / §A.4） */
function Thinking({ text, seconds }: { text: string; seconds: number | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-7 items-center gap-1 text-text-tertiary hover:text-text"
      >
        <ChevronRight aria-hidden className={["size-3.5 transition-transform", open ? "rotate-90" : ""].join(" ")} />
        思考{seconds !== null ? ` · ${seconds}s` : ""}
      </button>
      {open ? (
        <div className="mt-1 border-l-2 border-border pl-2 whitespace-pre-wrap text-text-tertiary">{text}</div>
      ) : null}
    </div>
  );
}
