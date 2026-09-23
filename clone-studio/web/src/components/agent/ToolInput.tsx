import { Markdown } from "./Markdown.js";

/** 文件扩展名 → 高亮语言。SVML 是 XML 形状，按 XML 高亮（Design-Brief §A.2「代码 / SVML：语法高亮」） */
const LANG: Record<string, string> = {
  svml: "xml",
  xml: "xml",
  html: "xml",
  md: "markdown",
  ts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  json: "json",
  py: "python",
  sh: "bash",
  css: "css",
  yaml: "yaml",
  yml: "yaml",
};

interface CodeBlock {
  label: string;
  code: string;
  lang: string;
}

/**
 * 工具调用点开后的入参（Design-Brief §A.2）。写文件、改文件、跑命令的入参本身就是代码：
 * 整段 JSON 转义成一行没法看，抽出来按代码块渲染——高亮、>20 行默认折叠都和回复里的代码一致。
 * 其余参数照原样给 JSON。
 */
export function ToolInput({ name, input }: { name: string; input: unknown }) {
  if (!isRecord(input)) return <Json value={input} />;
  const { blocks, rest } = extract(name, input);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {Object.keys(rest).length > 0 ? <Json value={rest} /> : null}
      {blocks.map((b, i) => (
        <div key={`${b.label}-${i}`} className="min-w-0">
          <div className="text-caption text-text-tertiary">{b.label}</div>
          <Markdown text={fence(b.code, b.lang)} />
        </div>
      ))}
    </div>
  );
}

function extract(name: string, input: Record<string, unknown>): { blocks: CodeBlock[]; rest: Record<string, unknown> } {
  const rest = { ...input };
  const blocks: CodeBlock[] = [];
  const lang = langOf(input.file_path ?? input.notebook_path);
  const take = (key: string, label: string, l = lang): void => {
    const v = rest[key];
    if (typeof v !== "string") return;
    blocks.push({ label, code: v, lang: l });
    delete rest[key];
  };
  if (name === "Bash") take("command", "命令", "bash");
  take("content", "内容");
  take("old_string", "替换前");
  take("new_string", "替换后");
  take("new_source", "新内容");
  if (name === "MultiEdit" && Array.isArray(rest.edits)) {
    rest.edits.forEach((e, i) => {
      if (!isRecord(e)) return;
      if (typeof e.old_string === "string") blocks.push({ label: `第 ${i + 1} 处 · 替换前`, code: e.old_string, lang });
      if (typeof e.new_string === "string") blocks.push({ label: `第 ${i + 1} 处 · 替换后`, code: e.new_string, lang });
    });
    delete rest.edits;
  }
  return { blocks, rest };
}

function langOf(path: unknown): string {
  if (typeof path !== "string") return "";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG[ext] ?? "";
}

/** 围栏比内容里最长的一串反引号还多一个，内容里有 ``` 也包得住 */
function fence(code: string, lang: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${code}\n${ticks}`;
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[480px] overflow-auto rounded-md border border-border bg-bg p-2 text-[12px] whitespace-pre-wrap text-text-secondary">
      {JSON.stringify(value, null, 2) ?? "（空）"}
    </pre>
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
