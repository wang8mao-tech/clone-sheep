import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Markdown } from "../agent/Markdown.js";
import { parseTimeline, splitAnalysis, type CloneFile, type CloneVerdict } from "../../lib/clone.js";

/**
 * SCREEN-004 左栏的三个可折叠区块（设计稿「② 复刻」）：卡片 #16181B、描边、圆角 8；
 * 头部高 36、折叠箭头 + 13/600 标题 + 等宽 11px 文件名；正文 padding 12×14。
 * 标题用 h2：页面标题是 h1（模板名），① 参考的区块标题也是 h2。
 */
function Section({ title, file, children }: { title: string; file?: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-surface">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          // 折叠时正文没挂载，aria-controls 不能指向一个不存在的元素
          {...(open ? { "aria-controls": bodyId } : {})}
          onClick={() => setOpen((v) => !v)}
          className={["flex h-9 w-full items-center gap-2 px-3 text-left", open ? "border-b border-border" : ""].join(
            " ",
          )}
        >
          {open ? (
            <ChevronDown aria-hidden className="size-3 text-text-tertiary" />
          ) : (
            <ChevronRight aria-hidden className="size-3 text-text-tertiary" />
          )}
          <span className="flex-1 text-[13px] font-semibold text-text">{title}</span>
          {file ? <span className="font-mono text-[11px] text-text-tertiary">{file}</span> : null}
        </button>
      </h2>
      {open ? (
        <div id={bodyId} className="px-3.5 py-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function TruncatedNote({ file }: { file: CloneFile }) {
  if (!file.truncated) return null;
  return <p className="mt-2 text-caption text-text-tertiary">文件超过 256 KB，这里只显示前面一部分。</p>;
}

/** 分析摘要：正文按 markdown 渲染，「不确定项」逐条标琥珀徽标（条目里的粗体、代码也照 markdown 渲染） */
export function AnalysisSection({ file }: { file: CloneFile }) {
  const { body, uncertain } = splitAnalysis(file.text);
  return (
    <Section title="分析摘要" file="ANALYSIS.md">
      <div className="flex flex-col gap-2 text-[13px] leading-[1.6] text-text">
        {body ? <Markdown text={body} /> : null}
        {uncertain.length ? (
          <ul aria-label="不确定项" className="flex flex-col gap-1.5">
            {uncertain.map((item, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="shrink-0 rounded-sm border border-warning/35 px-1.5 text-[11px] leading-[18px] whitespace-nowrap text-warning">
                  不确定项 {i + 1}
                </span>
                <div className="min-w-0 text-caption text-text-secondary">
                  <Markdown text={item} />
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <TruncatedNote file={file} />
    </Section>
  );
}

/**
 * 时间线：时间码可点，参考播放器跳到该处（SCREEN-004）。一行都认不出时照 markdown 原样显示。
 * 时间码列 112px：Agent 按提示写 `mm:ss.s` 起止，压紧后最长 `00:00-00:03.5`，设计稿的 84px 装不下，不换行
 * （偏差记在 DEV-PLAN）。参考视频还没落盘时时间码不可点。
 */
export function TimelineSection({
  file,
  canSeek,
  onSeek,
}: {
  file: CloneFile;
  canSeek: boolean;
  onSeek: (seconds: number) => void;
}) {
  const rows = parseTimeline(file.text);
  return (
    <Section title="时间线" file="TIMELINE.md">
      {rows.length ? (
        <ol className="flex flex-col">
          {rows.map((row, i) => (
            <li key={i} className="flex min-h-7 items-start gap-2 py-1">
              <button
                type="button"
                title={canSeek ? "参考视频跳到这里" : "参考视频还没准备好"}
                disabled={!canSeek}
                onClick={() => onSeek(row.start)}
                className="min-w-[112px] shrink-0 rounded-sm text-left font-mono text-[12px] leading-5 text-primary tabular-nums whitespace-nowrap hover:underline disabled:cursor-default disabled:opacity-60 disabled:hover:no-underline"
              >
                {row.label}
              </button>
              <span className="min-w-0 text-[13px] leading-5 text-text">{row.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="text-[13px] text-text">
          <Markdown text={file.text} />
        </div>
      )}
      <TruncatedNote file={file} />
    </Section>
  );
}

/** 校验结果：通过 / 未过 + 原文。未过时写明缺什么、check 说了什么（REQ-004 完成判据） */
export function VerdictSection({ verdict }: { verdict: CloneVerdict }) {
  return (
    <Section title="校验结果">
      {verdict.ok ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-caption text-success">
            <span aria-hidden className="size-2 rounded-full bg-success" />✓ hypit check 通过
          </span>
          <span className="font-mono text-[11px] text-text-tertiary">{checkSummary(verdict.check)}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="inline-flex items-center gap-1.5 text-caption text-danger">
            <span aria-hidden className="size-2 rounded-full bg-danger" />✕ 未达完成判据
          </span>
          {verdict.missing.length ? (
            <p className="text-caption text-text-secondary">缺少 {verdict.missing.join("、")}</p>
          ) : null}
          {verdict.error ? <Raw text={verdict.error} /> : null}
          {verdict.check !== null && verdict.check !== undefined ? (
            <Raw text={JSON.stringify(verdict.check, null, 2)} />
          ) : null}
        </div>
      )}
    </Section>
  );
}

/** 上游原文等宽原样展示（Design-Brief §6.2）；长到没有空格的一行也折进卡片里，不出横向滚动条 */
function Raw({ text }: { text: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-[11px] break-all whitespace-pre-wrap text-text-secondary">
      {text}
    </pre>
  );
}

/** 通过时的一行摘要，只用 check 真给了的字段（hypit.cli-check@1：run、targetCount） */
function checkSummary(check: unknown): string {
  if (!check || typeof check !== "object") return "reference.svrun";
  const c = check as { run?: unknown; targetCount?: unknown };
  const run = typeof c.run === "string" ? c.run : "reference.svrun";
  return typeof c.targetCount === "number" ? `${run} · ${c.targetCount} 个目标` : run;
}
