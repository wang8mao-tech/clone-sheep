import { useId, useRef } from "react";
import { BRIEF_MAX, BRIEF_MIN, EXAMPLE_BRIEFS, type BriefCheck } from "../../lib/variants.js";

interface Props {
  value: string;
  onChange: (next: string) => void;
  check: BriefCheck;
  /** 这一批最多几条（设置与 20 的较小值） */
  max: number;
  disabled?: boolean;
}

/** 行高与字号固定：行号栏和文本框逐行对齐靠它 */
const LINE_PX = 20;

/**
 * SCREEN-006 的多行 brief 文本框：等宽行号、实时「N 条」、逐行红字（超 20 条、单行超 500 字不让提交）。
 * 空状态在下方列三条示例，点击填入（Design-Brief §7.4：一句话 + 一个动作）。
 * 行号栏是一列跟着文本框滚动的数字，不做成可编辑的一部分：读屏只读文本框本身，行号 aria-hidden
 */
export function BriefEditor({ value, onChange, check, max, disabled = false }: Props) {
  const id = useId();
  const gutter = useRef<HTMLDivElement>(null);
  // 至少和文本框的可见行数一样多（8 行），空的时候每一行也有号
  const lineCount = Math.max(value.split(/\r?\n/).length, 8);
  const bad = new Set(check.lines.map((l) => l.line));
  const errors = [...(check.batchError ? [check.batchError] : []), ...check.lines.map((l) => l.message)];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-caption font-medium text-text-secondary">
          Brief（一行一条）
        </label>
        <span aria-live="polite" className="font-mono text-caption text-text-secondary">
          {check.count} 条
        </span>
      </div>
      <div
        className={[
          // 焦点环画在外框上：文本框自己去掉了 outline，行号栏与文本框一起算一个输入框（§8.2 焦点可见）
          "flex overflow-hidden rounded-md border bg-bg font-mono text-[12px] focus-within:ring-2 focus-within:ring-primary",
          errors.length ? "border-danger" : "border-border",
        ].join(" ")}
      >
        <div
          ref={gutter}
          aria-hidden
          className="shrink-0 overflow-hidden border-r border-border px-2 py-1.5 text-right text-text-tertiary select-none"
          style={{ lineHeight: `${LINE_PX}px`, height: `${LINE_PX * 8 + 12}px` }}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className={bad.has(i + 1) ? "text-danger" : undefined}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          id={id}
          value={value}
          disabled={disabled}
          rows={8}
          wrap="off"
          spellCheck={false}
          aria-invalid={errors.length ? true : undefined}
          aria-describedby={errors.length ? `${id}-help ${id}-errors` : `${id}-help`}
          placeholder={EXAMPLE_BRIEFS[0]}
          onChange={(e) => onChange(e.currentTarget.value)}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
          className="min-w-0 flex-1 resize-none bg-transparent px-2.5 py-1.5 text-text outline-none placeholder:text-text-tertiary disabled:opacity-40"
          style={{ lineHeight: `${LINE_PX}px`, height: `${LINE_PX * 8 + 12}px` }}
        />
      </div>
      <p id={`${id}-help`} className="text-caption text-text-tertiary">
        一行一条，每条 {BRIEF_MIN}-{BRIEF_MAX} 字，最多 {max} 条；空行不算。
      </p>
      {errors.length ? (
        <ul id={`${id}-errors`} role="alert" className="flex flex-col gap-0.5 text-caption text-danger">
          {errors.slice(0, 5).map((e) => (
            <li key={e}>{e}</li>
          ))}
          {errors.length > 5 ? <li>还有 {errors.length - 5} 处不合格</li> : null}
        </ul>
      ) : null}
      {value.trim() === "" ? (
        <div className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">还没有 brief。点一条示例填进去：</span>
          {EXAMPLE_BRIEFS.map((example) => (
            <button
              key={example}
              type="button"
              disabled={disabled}
              onClick={() => onChange(example)}
              className="w-fit rounded px-1.5 py-0.5 text-left text-caption text-primary hover:bg-surface-raised"
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
