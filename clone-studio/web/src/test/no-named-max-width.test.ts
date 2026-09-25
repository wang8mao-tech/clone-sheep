import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 这套 Tailwind 配置没有 --container-* 刻度：max-w-sm / md / lg / xl … 会解析成同名的间距 token（12px、16px…），
 * 整块塌成一字一行。已经踩过三次（RouteErrorPage、QueryErrorState、⑤ 播放弹层的错误区，9.2 第五轮审查 S1-H1），
 * 这里扫一遍源码，出现就挂。宽度一律写显式值（w-[420px]、max-w-[448px]）
 */

const ROOT = path.resolve(__dirname, "..");
// 只看引号里的类名字符串：注释里提到它（解释为什么不用）不算
const NAMED = /["'`][^"'`]*\b(?:max-w|min-w|w|max-h|min-h|h|basis|size)-(?:xs|sm|md|lg|xl|[2-7]xl)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx") ? [full] : [];
  });
}

describe("不用具名的 max-w-*", () => {
  it("源码里的 className 不出现 max-w-sm / md / lg / xl …", () => {
    const hits = files(ROOT).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => NAMED.test(line) && !/^\s*(\/\/|\*|\{\/\*)/.test(line))
        .map(({ i }) => `${path.relative(ROOT, file)}:${i + 1}`),
    );
    expect(hits).toEqual([]);
  });
});
