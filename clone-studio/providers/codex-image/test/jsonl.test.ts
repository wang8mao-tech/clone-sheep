import { describe, expect, it } from "vitest";
import {
  emptyEvents,
  LineSplitter,
  LineTooLongError,
  MAX_ERROR_CHARS,
  MAX_ERRORS,
  MAX_LINE_BYTES,
  MAX_TAIL_LINE_CHARS,
  readEvent,
  TAIL_LINES,
} from "../src/jsonl.js";

describe("LineSplitter：按行切 JSONL", () => {
  it("跨块拼行、去掉 \\r、空行不要，最后一段等 end()", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n\n{"c":3}')).toEqual(['{"b":2}']);
    expect(s.end()).toEqual(['{"c":3}']);
    expect(s.end()).toEqual([]);
  });

  it("一行一直不换行、超过 4 MB：抛错，不无限攒内存", () => {
    const s = new LineSplitter();
    expect(() => s.push("x".repeat(MAX_LINE_BYTES + 1))).toThrow(LineTooLongError);
  });

  it("一块里一整行超过 4 MB（带换行）也拒；刚好 4 MB 放行", () => {
    expect(() => new LineSplitter().push(`${"x".repeat(MAX_LINE_BYTES + 1)}\n`)).toThrow(LineTooLongError);
    expect(new LineSplitter().push(`${"x".repeat(MAX_LINE_BYTES)}\n`)).toHaveLength(1);
  });
});

describe("readEvent：汇总 Codex 事件", () => {
  it("thread.started 取第一条的 thread_id", () => {
    const e = emptyEvents();
    readEvent(e, JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    readEvent(e, JSON.stringify({ type: "thread.started", thread_id: "t-2" }));
    expect(e.threadId).toBe("t-1");
  });

  it("error 事件是失败、原文留着；断流重连提示不算失败", () => {
    const e = emptyEvents();
    readEvent(e, JSON.stringify({ type: "error", message: "Reconnecting... 2/5" }));
    expect(e.errors).toEqual([]);
    readEvent(e, JSON.stringify({ type: "error", message: "stream error: broken pipe" }));
    expect(e.errors).toEqual(["stream error: broken pipe"]);
  });

  it("turn.failed 取 error.message；没有 message 就留整条事件", () => {
    const e = emptyEvents();
    readEvent(e, JSON.stringify({ type: "turn.failed", error: { message: "model stream ended" } }));
    readEvent(e, JSON.stringify({ type: "turn.failed" }));
    expect(e.errors).toEqual(["model stream ended", '{"type":"turn.failed"}']);
  });

  it("不是 JSON 的行只进末段、不判失败；末段只留最后若干行", () => {
    const e = emptyEvents();
    readEvent(e, "WARNING: something plain");
    expect(e.errors).toEqual([]);
    for (let i = 0; i < TAIL_LINES + 3; i += 1) readEvent(e, JSON.stringify({ type: "item.started", n: i }));
    expect(e.tail).toHaveLength(TAIL_LINES);
    expect(e.tail.at(-1)).toContain(`"n":${TAIL_LINES + 2}`);
    expect(e.tail.join("\n")).not.toContain("WARNING");
  });
});

describe("readEvent：带回的原文有上限（11.1 审查 M2）", () => {
  it("末段每行截到上限并标明截断；12 行加起来也就几十 KB，不会是几十 MB", () => {
    const e = emptyEvents();
    const big = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: "x".repeat(500_000) },
    });
    for (let i = 0; i < TAIL_LINES; i += 1) readEvent(e, big);
    for (const line of e.tail) {
      expect(line.length).toBeLessThanOrEqual(MAX_TAIL_LINE_CHARS + 40);
      expect(line).toMatch(/^\{"type":"item\.completed"/u);
      expect(line).toContain("截断");
    }
    expect(e.tail.join(String.fromCharCode(10)).length).toBeLessThan(TAIL_LINES * (MAX_TAIL_LINE_CHARS + 41));
  });

  it("短行原样；error 原文同样截到上限", () => {
    const e = emptyEvents();
    readEvent(e, JSON.stringify({ type: "turn.started" }));
    expect(e.tail).toEqual(['{"type":"turn.started"}']);
    readEvent(e, JSON.stringify({ type: "error", message: `boom ${"y".repeat(100_000)}` }));
    expect(e.errors[0]!.length).toBeLessThanOrEqual(MAX_ERROR_CHARS + 40);
    expect(e.errors[0]).toMatch(/^boom y+/u);
  });
});

describe("readEvent：错误条数也有上限（11.1 审查 M2）", () => {
  it("一直刷 error：只记前几条", () => {
    const e = emptyEvents();
    for (let i = 0; i < MAX_ERRORS + 20; i += 1) readEvent(e, JSON.stringify({ type: "error", message: `e${i}` }));
    expect(e.errors).toHaveLength(MAX_ERRORS);
    expect(e.errors[0]).toBe("e0");
  });
});
