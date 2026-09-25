import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";
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
  /** 整行点进去的地址。给了就把标题渲染成链接，并让整行可点 */
  href?: string;
  /**
   * 可点行的无障碍名，如「打开模板 足球榜单」。
   * 不给的话名字由行内容拼出来——状态、名称、几个数字糊成一串，
   * 屏幕阅读器念出来没法听，也和行尾菜单按钮的名字撞车。
   */
  openLabel?: string;
  /** 失败行的错误原文，给了就能就地展开 */
  errorDetail?: string;
  /**
   * 要人动手的行左侧 2px 竖线（SCREEN-006：素材待审强调色、待确认花费琥珀）。同一张表里别的行传 "none"
   * （透明竖线，列还对得齐）；不传就没有竖线——客户页这类没有竖线的表不受影响（8.3 审查 S2-M1）
   */
  accent?: "primary" | "warning" | "none";
  /**
   * 同一张表里有的行带展开箭头、有的不带：没箭头的行也留出箭头的宽度，列才和列头对得齐（8.3 审查 LOW / Task 9.3）。
   * 不传就不留——客户页没有展开箭头，不受影响
   */
  reserveExpander?: boolean;
}

/**
 * CMP-002 任务紧凑行：行高 36px、列对齐、数字列等宽右对齐、悬停显行尾动作、
 * 失败行可就地展开错误原文。
 *
 * 做成原语是因为 SCREEN-002 的模板列表与 SCREEN-006 的变体队列是同一种行，
 * 只是列不一样。列宽由调用方给，行本身不猜。
 *
 * 整行可点用的是"标题链接撑满整行"（after:inset-0），不是给行套 role="button"。
 * 后者是 ARIA 的 presentational-children 角色，把行尾菜单按钮罩在里面属于非法
 * 嵌套，读屏在浏览模式下会把菜单整个吞掉。行尾动作靠 z-10 浮在链接之上。
 * 侧栏的模板行也是用 NavLink 做的，两处同一套先例。
 */
export function TaskRow({
  lead,
  title,
  columns,
  actions,
  href,
  openLabel,
  errorDetail,
  accent,
  reserveExpander,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li
      className={[
        "group border-b border-b-border/60 last:border-b-0",
        accent === undefined
          ? ""
          : accent === "primary"
            ? "border-l-2 border-l-primary"
            : accent === "warning"
              ? "border-l-2 border-l-warning"
              : "border-l-2 border-l-transparent",
      ].join(" ")}
    >
      {/* relative 挂在这一行上而不是 li 上：挂 li 的话，展开错误原文后 li 变高，
          整行覆盖层跟着罩住展开区，点那片留白会跳走 */}
      <div className="relative flex h-9 items-center gap-3 px-3 text-[13px]">
        {errorDetail ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "收起错误原文" : "展开错误原文"}
            onClick={() => setExpanded((v) => !v)}
            className="relative z-10 shrink-0 text-text-tertiary hover:text-text"
          >
            {expanded ? (
              <ChevronDown aria-hidden className="size-3.5" />
            ) : (
              <ChevronRight aria-hidden className="size-3.5" />
            )}
          </button>
        ) : reserveExpander ? (
          <span aria-hidden data-expander-slot className="size-3.5 shrink-0" />
        ) : null}

        {lead ? <div className="flex shrink-0 items-center">{lead}</div> : null}

        <div className="min-w-0 flex-1 truncate">
          {href ? (
            <Link
              to={href}
              aria-label={openLabel}
              className="text-text after:absolute after:inset-0 after:content-['']"
            >
              {title}
            </Link>
          ) : (
            title
          )}
        </div>

        {columns.map((col) => (
          <div
            key={col.label}
            style={{ width: col.width }}
            className={["shrink-0 truncate text-text-secondary", col.numeric ? "text-right font-mono" : ""].join(" ")}
          >
            {col.content}
          </div>
        ))}

        {actions ? (
          <div className="relative z-10 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {actions}
          </div>
        ) : null}
      </div>

      {errorDetail && expanded ? (
        <pre className="relative z-10 mx-3 mb-2 max-h-40 overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-caption whitespace-pre-wrap text-text-secondary">
          {errorDetail}
        </pre>
      ) : null}
    </li>
  );
}
