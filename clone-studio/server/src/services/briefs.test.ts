import { describe, expect, it } from "vitest";
import { briefTitle, parseBriefs } from "./briefs.js";

/** REQ-005 输入表与 FLOW-003 边界：空行忽略、每行 5-500 字、1-20 条（AC-016） */

const line = (n: number) => "字".repeat(n);

describe("parseBriefs", () => {
  it("一行一条，空行与首尾空白忽略", () => {
    expect(parseBriefs("  换成手机排行榜  \n\n\r\n换成汽车排行榜\n   \n")).toEqual({
      ok: true,
      briefs: ["换成手机排行榜", "换成汽车排行榜"],
    });
  });

  it("每行 5 字与 500 字都行，4 字与 501 字不行，行号按原文（空行也占号）", () => {
    expect(parseBriefs(`${line(5)}\n${line(500)}`)).toMatchObject({ ok: true });
    const r = parseBriefs(`${line(5)}\n\n${line(4)}\n${line(501)}`);
    expect(r).toMatchObject({
      ok: false,
      code: "BAD_LINES",
      count: 3,
      lines: [
        { line: 3, length: 4, problem: "too_short" },
        { line: 4, length: 501, problem: "too_long" },
      ],
    });
    expect(r.ok === false && r.message).toBe("第 3 行不到 5 字，另有 1 行也不合格");
  });

  it("字数按字符算：emoji 算一个，不按 UTF-16 算成两个", () => {
    expect(parseBriefs("😀😀😀😀😀")).toMatchObject({ ok: true });
    expect(parseBriefs("😀😀😀😀")).toMatchObject({ ok: false, code: "BAD_LINES" });
  });

  it("20 条可以；21 条整批拒绝，提示一次最多 20 条（AC-016）", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `第 ${i} 条变体 brief`).join("\n");
    expect(parseBriefs(twenty)).toMatchObject({ ok: true });
    const r = parseBriefs(`${twenty}\n再多一条的 brief`);
    expect(r).toMatchObject({ ok: false, code: "TOO_MANY", count: 21 });
    expect(r.ok === false && r.message).toBe("一次最多 20 条，现在是 21 条");
  });

  it("上限跟着设置走", () => {
    expect(parseBriefs("第一条 brief\n第二条 brief\n第三条 brief", 2)).toMatchObject({ ok: false, code: "TOO_MANY" });
  });

  it("全是空行：至少写一条", () => {
    expect(parseBriefs("\n  \n")).toMatchObject({ ok: false, code: "EMPTY", count: 0 });
  });

  it("超 500 字的那一行报在第一个", () => {
    const r = parseBriefs(line(600));
    expect(r.ok === false && r.message).toBe("第 1 行超过 500 字（600）");
  });
});

describe("briefTitle", () => {
  it("默认名称取 brief 前 20 字（REQ-007），连续空白压成一个", () => {
    expect(briefTitle("换成 2026 年手机品牌排行，毒舌风格。普通话")).toBe("换成 2026 年手机品牌排行，毒舌风格");
    expect(briefTitle("换成 2026 年手机品牌排行，毒舌风格。普通话更好")).toHaveLength(20);
    expect(briefTitle("  换成\n\n手机   排行  ")).toBe("换成 手机 排行");
    expect([...briefTitle(line(60))].length).toBe(20);
    expect(briefTitle("短的")).toBe("短的");
  });
});
