import type { ReactNode } from "react";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface TaskRowColumn {
  /** 表头文字，也用作无障碍标签 */
  label: string;
  content: ReactNode;
  /** 数字列：等宽右对齐（Design-Brief 5.2） */
  numeric?: boolean;
  /** 列宽，如 "96px"、"1fr" */
  width: string;
}

interface Props {
  /** 行首的状态点或缩略图 */
  lead?: ReactNode;
  /** 主标题列，占满剩余宽度 */
  title: ReactNode;
  columns: readonly TaskRowColumn[];
  /** 悬停才出现的行尾动作 */
  actions?: ReactNode;
  /** 整行点击（进详情）。给了就渲染成可点的行 */
  onOpen?: () => void;
  /**
   * 可点行的无障碍名，如「打开模板 足球榜单」。
   * 不给的话名字由行内容拼出来——状态、名称、几个数字糊成一串，
   * 屏幕阅读器念出来没法听，也和行尾菜单按钮的名字撞车。
   */
  openLabel?: string;
  /** 失败行的错误原文，给了就能就地展开 */
  errorDetail?: string;
  /** 需要人动手的行：左侧 2px 竖线（Design-Brief SCREEN-006） */
  accent?: "primary" | "warning";
}

const ACCENT: Record<NonNullable<Props["accent"]>, string> = {
  primary: "before:bg-primary",
  warning: "before:bg-warning",
};

/**
 * CMP-002 任务紧凑行：行高 36px、列对齐、数字列等宽右对齐、悬停显行尾动作、
 * 失败行可就地展开错误原文。
 *
 * 做成原语是因为 SCREEN-002 的模板列表与 SCREEN-006 的变体队列是同一种行，
 * 只是列不一样。列宽由调用方给，行本身不猜。
 */
export function TaskRow({ lead, title, columns, actions, onOpen, openLabel, errorDetail, accent }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li
      className={[
        "group relative border-b border-border/60 last:border-b-0",
        accent
          ? `before:absolute before:top-0 before:bottom-0 before:left-0 before:w-0.5 before:content-[''] ${ACCENT[accent]}`
          : "",
      ].join(" ")}
    >
      <div
        className={[
          "flex h-9 items-center gap-3 px-3 text-[13px]",
          onOpen ? "cursor-pointer hover:bg-surface-raised" : "",
        ].join(" ")}
        onClick={onOpen}
        onKeyDown={
          onOpen
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen();
                }
              }
            : undefined
        }
        role={onOpen ? "button" : undefined}
        aria-label={onOpen ? openLabel : undefined}
        tabIndex={onOpen ? 0 : undefined}
      >
        {errorDetail ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "收起错误原文" : "展开错误原文"}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="shrink-0 text-text-tertiary hover:text-text"
          >
            {expanded ? (
              <ChevronDown aria-hidden className="size-3.5" />
            ) : (
              <ChevronRight aria-hidden className="size-3.5" />
            )}
          </button>
        ) : null}

        {lead ? <div className="flex shrink-0 items-center">{lead}</div> : null}

        <div className="min-w-0 flex-1 truncate">{title}</div>

        {columns.map((col) => (
          <div
            key={col.label}
            style={{ width: col.width }}
            className={[
              "shrink-0 truncate text-text-secondary",
              col.numeric ? "text-right font-mono" : "",
            ].join(" ")}
          >
            {col.content}
          </div>
        ))}

        {actions ? (
          <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {actions}
          </div>
        ) : null}
      </div>

      {errorDetail && expanded ? (
        <pre className="mx-3 mb-2 max-h-40 overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-caption whitespace-pre-wrap text-text-secondary">
          {errorDetail}
        </pre>
      ) : null}
    </li>
  );
}
