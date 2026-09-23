import { describe, expect, it } from "vitest";
import { formatDuration, formatRunElapsed, runElapsedMs } from "./run-elapsed.js";
import type { AgentJobStatus } from "./agent.js";

const START = "2026-09-23T10:00:00.000Z";
const at = (s: number) => Date.parse(START) + s * 1000;
const timing = (status: AgentJobStatus, runElapsedMs: number, runStartedAt: string | null = START) => ({
  status,
  runElapsedMs,
  runStartedAt,
});

describe("本次运行用时（DEV-PLAN Phase 5 那条公式）", () => {
  it("运行中：之前几段 + 当前这段", () => {
    expect(runElapsedMs(timing("running", 90_000), at(30))).toBe(120_000);
  });

  it("等额度、排队：只算之前几段，冻住不走", () => {
    for (const s of ["awaiting_quota", "queued"] as const) {
      expect(runElapsedMs(timing(s, 90_000), at(600))).toBe(90_000);
    }
  });

  it("终态：只认累计值，不拿 now 减 runStartedAt", () => {
    for (const s of ["done", "tripped", "interrupted", "failed", "cancelled"] as const) {
      expect(runElapsedMs(timing(s, 42_000), at(3600))).toBe(42_000);
    }
  });

  it("客户端时钟比服务端慢：running 那段算出负数时夹到 0，不显示负用时", () => {
    expect(runElapsedMs(timing("running", 0), at(-5))).toBe(0);
    expect(runElapsedMs(timing("running", 10_000), at(-60))).toBe(0);
  });

  it("running 却没有 runStartedAt（坏数据）：不崩，按累计值", () => {
    expect(runElapsedMs(timing("running", 5_000, null), at(10))).toBe(5_000);
  });

  it("后端崩溃被标中断：终态累计 0 且 runStartedAt 非空显示「—」，没开始过的显示 0:00", () => {
    expect(formatRunElapsed(timing("interrupted", 0), at(100))).toBe("—");
    expect(formatRunElapsed(timing("cancelled", 0, null), at(100))).toBe("0:00");
    expect(formatRunElapsed(timing("queued", 0), at(100))).toBe("0:00");
    expect(formatRunElapsed(timing("interrupted", 61_000), at(100))).toBe("1:01");
  });

  it("格式：m:ss，超过一小时 h:mm:ss，NaN 给 0:00", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(59_999)).toBe("0:59");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });
});
