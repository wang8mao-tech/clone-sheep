/**
 * 长内容折叠（Design-Brief §A.2）：命令输出 >12 行折叠、保留首尾；代码 >20 行默认折叠。
 * 只折给人看的那份，落库和喂模型的原文一个字不动。
 */

/** 命令输出超过这么多行就折叠 */
export const OUTPUT_FOLD_LINES = 12;
/** 代码块超过这么多行就折叠（Markdown.tsx 用限高折，保留高亮节点） */
export const CODE_FOLD_LINES = 20;

export interface Folded {
  /** 是否需要折叠 */
  folded: boolean;
  head: string;
  tail: string;
  /** 中间省略了几行 */
  hidden: number;
  total: number;
}

/** 保留首尾各一半，中间省略。不超过 limit 行时原样返回 */
export function foldHeadTail(text: string, limit = OUTPUT_FOLD_LINES): Folded {
  const lines = splitLines(text);
  if (lines.length <= limit) return { folded: false, head: text, tail: "", hidden: 0, total: lines.length };
  const keep = Math.max(1, Math.floor(limit / 2));
  return {
    folded: true,
    head: lines.slice(0, keep).join("\n"),
    tail: lines.slice(-keep).join("\n"),
    hidden: lines.length - keep * 2,
    total: lines.length,
  };
}

function splitLines(text: string): string[] {
  // 末尾的换行不算一行：「a\nb\n」是两行
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed.split("\n");
}
