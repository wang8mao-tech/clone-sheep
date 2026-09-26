import { useState } from "react";
import {
  Ban,
  BookOpen,
  Check,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { foldHeadTail } from "../../lib/fold.js";
import { formatDuration } from "../../lib/run-elapsed.js";
import { summarizeInput, toneOf, type ToolItem } from "../../lib/agent-timeline.js";
import { ToneBlock } from "./ToneBlock.js";
import { ToolInput } from "./ToolInput.js";

/** 工具名 → 图标。写成函数而不是查表：图标组件放进对象字面量时 lint 的类型推断会丢 */
function ToolIcon({ name }: { name: string }) {
  const cls = "size-3.5 shrink-0 text-text-secondary";
  switch (name) {
    case "Bash":
      return <Terminal aria-hidden className={cls} />;
    case "Read":
      return <FileText aria-hidden className={cls} />;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return <FilePen aria-hidden className={cls} />;
    case "Glob":
    case "Grep":
    case "WebSearch":
      return <Search aria-hidden className={cls} />;
    case "WebFetch":
      return <Globe aria-hidden className={cls} />;
    case "TodoWrite":
      return <ListTodo aria-hidden className={cls} />;
    case "Skill":
      return <BookOpen aria-hidden className={cls} />;
    default:
      return <Wrench aria-hidden className={cls} />;
  }
}

/**
 * 工具调用折叠行（Design-Brief §A.2）：图标 + 工具名 + 参数摘要 + 耗时 + 成败，点开看完整入参与输出。
 * 跑工具中显示转圈与已用时长（§A.3）。失败的红竖线、被宿主拦截的琥珀竖线。
 *
 * `running` 由抽屉给：任务已经停了的话，没等到结果的工具不再转圈，标「未完成」。
 */
export function ToolRow({ item, running, now }: { item: ToolItem; running: boolean; now: number }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeInput(item.name, item.input);
  const result = item.result;
  const tone = toneOf(item);
  const elapsedMs = (result ? Date.parse(result.at) : now) - Date.parse(item.startedAt);
  const pending = !result && running;
  const state = pending
    ? "运行中"
    : !result
      ? "未完成"
      : result.intercepted
        ? "已拦截"
        : result.isError
          ? "失败"
          : "成功";

  return (
    <ToneBlock tone={tone} className="rounded-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${item.name} ${summary}，${state}`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left hover:bg-surface-raised"
      >
        <ChevronRight
          aria-hidden
          className={["size-3.5 shrink-0 text-text-tertiary transition-transform", open ? "rotate-90" : ""].join(" ")}
        />
        <ToolIcon name={item.name} />
        <span className="shrink-0 text-text">{item.name}</span>
        <span className="min-w-0 flex-1 truncate text-text-tertiary" title={summary}>
          {summary}
        </span>
        {result || pending ? (
          <span className="shrink-0 text-caption text-text-tertiary">{formatDuration(elapsedMs)}</span>
        ) : null}
        <ToolState pending={pending} result={result} />
      </button>
      {open ? (
        <div className="mt-1 mb-2 flex flex-col gap-2 pl-6">
          <div className="min-w-0">
            <div className="mb-0.5 text-caption text-text-tertiary">入参</div>
            <ToolInput name={item.name} input={item.input} />
          </div>
          {result ? <Section title={result.isError ? "输出（出错）" : "输出"} text={result.text} /> : null}
        </div>
      ) : null}
    </ToneBlock>
  );
}

function ToolState({ pending, result }: { pending: boolean; result: ToolItem["result"] }) {
  if (pending)
    return <Loader2 role="img" aria-label="运行中" className="size-3.5 shrink-0 animate-spin text-primary" />;
  if (!result) return <span className="shrink-0 text-caption text-text-tertiary">未完成</span>;
  if (result.intercepted) return <Ban role="img" aria-label="已拦截" className="size-3.5 shrink-0 text-warning" />;
  if (result.isError) return <X role="img" aria-label="失败" className="size-3.5 shrink-0 text-danger" />;
  return <Check role="img" aria-label="成功" className="size-3.5 shrink-0 text-success" />;
}

/** 输出原文：>12 行折叠、保留首尾（§A.2 命令输出） */
function Section({ title, text }: { title: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const folded = foldHeadTail(text);
  const collapsed = folded?.folded === true && !expanded;
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-caption text-text-tertiary">{title}</div>
      <pre className="max-h-[480px] overflow-auto rounded-md border border-border bg-bg p-2 text-[12px] whitespace-pre-wrap text-text-secondary">
        {collapsed && folded ? (
          <>
            {folded.head}
            {"\n"}
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="inline-flex min-h-7 items-center text-text-tertiary underline hover:text-text"
            >
              … 省略 {folded.hidden} 行，展开全部 {folded.total} 行
            </button>
            {"\n"}
            {folded.tail}
          </>
        ) : (
          text || "（空）"
        )}
      </pre>
    </div>
  );
}
