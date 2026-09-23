import { describe, expect, it } from "vitest";
import { foldHeadTail, OUTPUT_FOLD_LINES } from "./fold.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

describe("命令输出折叠：>12 行保留首尾", () => {
  it("正好 12 行不折；末尾换行不算一行", () => {
    expect(foldHeadTail(lines(OUTPUT_FOLD_LINES)).folded).toBe(false);
    expect(foldHeadTail(`${lines(OUTPUT_FOLD_LINES)}\n`).folded).toBe(false);
  });

  it("13 行：首 6 尾 6，中间省略 1 行", () => {
    const f = foldHeadTail(lines(13));
    expect(f).toMatchObject({ folded: true, hidden: 1, total: 13 });
    expect(f.head.split("\n")).toEqual(["L1", "L2", "L3", "L4", "L5", "L6"]);
    expect(f.tail.split("\n")).toEqual(["L8", "L9", "L10", "L11", "L12", "L13"]);
  });
});
