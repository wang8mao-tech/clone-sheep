import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CODE_FOLD_LINES } from "../../lib/fold.js";

/**
 * Agent 回复的 markdown 渲染（Design-Brief §A.2 / §9）：等宽、代码高亮、代码块 >20 行默认折叠。
 * 折叠用限高而不是截字：高亮后的节点树原样保留，展开就是去掉限高。
 */
export function Markdown({ text, cursor = false }: { text: string; cursor?: boolean }) {
  return (
    <div className="agent-md min-w-0 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
      {cursor ? <StreamCursor /> : null}
    </div>
  );
}

/** 流式输出中的末尾光标块（Design-Brief §A.3） */
export function StreamCursor() {
  return (
    <span
      aria-hidden
      data-testid="stream-cursor"
      className="ml-0.5 inline-block h-[1.1em] w-[0.55em] animate-pulse bg-text-secondary align-text-bottom"
    />
  );
}

const COMPONENTS: Components = {
  pre: ({ node, children }) => <FoldableCode lines={countLines(node)}>{children}</FoldableCode>,
  // 图片不直接加载：Agent 写的 markdown 里的地址可能指向任何主机，显示成链接，人点了才去
  img: ({ src, alt }) =>
    typeof src === "string" ? (
      <a href={src} target="_blank" rel="noreferrer noopener" className="underline">
        [图片{alt ? `：${alt}` : ""}]
      </a>
    ) : null,
  // 模型给的链接可能指向任何地方：新窗口打开，不带 referrer
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="underline">
      {children}
    </a>
  ),
};

function FoldableCode({ lines, children }: { lines: number; children: ReactNode }) {
  const foldable = lines > CODE_FOLD_LINES;
  const [open, setOpen] = useState(false);
  const folded = foldable && !open;
  return (
    <div className="my-2">
      <pre
        data-folded={folded || undefined}
        style={folded ? { maxHeight: `${CODE_FOLD_LINES * 1.55}em` } : undefined}
        className="overflow-x-auto overflow-y-hidden rounded-md border border-border bg-bg p-2"
      >
        {children}
      </pre>
      {foldable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-h-7 text-caption text-text-tertiary hover:text-text"
        >
          {open ? "收起代码" : `展开全部 ${lines} 行`}
        </button>
      ) : null}
    </div>
  );
}

interface HastLike {
  type?: string;
  value?: unknown;
  children?: HastLike[];
}

/** 代码块有几行：数 hast 里文字节点的换行，末尾换行不算一行 */
function countLines(node: HastLike | undefined): number {
  const text = collect(node);
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed ? trimmed.split("\n").length : 0;
}

function collect(node: HastLike | undefined): string {
  if (!node) return "";
  if (node.type === "text" && typeof node.value === "string") return node.value;
  return (node.children ?? []).map(collect).join("");
}
