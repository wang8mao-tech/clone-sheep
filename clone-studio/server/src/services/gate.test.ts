import { describe, expect, it } from "vitest";
import { decideGate } from "./gate.js";

/** 花钱闸门（REQ-006）：AC-017 / 018 / 019 的判定，以及估价拿不到按超限 */

const LIMITS = { perItemLimitUsd: 1.5 };

describe("单条限额", () => {
  it("AC-017：单条限额 $1.5、估价 $0.9、批次未超 → 自动放行", () => {
    expect(decideGate({ ...LIMITS, estimateUsd: 0.9, batch: { limitUsd: 15, spentUsd: 3, halted: false } })).toEqual({
      pass: true,
    });
  });

  it("AC-018：估价 $2.1 → 停下等确认，原因是超过单条限额", () => {
    expect(decideGate({ ...LIMITS, estimateUsd: 2.1 })).toEqual({ pass: false, reasons: ["over_item_limit"] });
  });

  it("刚好压线（$1.5）放行；浮点和压线也放行", () => {
    expect(decideGate({ ...LIMITS, estimateUsd: 1.5 })).toEqual({ pass: true });
    expect(decideGate({ perItemLimitUsd: 0.3, estimateUsd: 0.1 + 0.2 })).toEqual({ pass: true });
  });

  it("复刻片没有批次：只看单条限额", () => {
    expect(decideGate({ ...LIMITS, estimateUsd: 0 })).toEqual({ pass: true });
  });
});

describe("估价拿不到", () => {
  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, -1])("估价是 %s → 按超限，等确认", (estimateUsd) => {
    expect(decideGate({ ...LIMITS, estimateUsd })).toEqual({ pass: false, reasons: ["estimate_unknown"] });
  });
});

describe("批次限额", () => {
  it("AC-019：批次已花 $14.5、限额 $15、这条 $0.9 → 停下，原因是批次超限（单条没超）", () => {
    expect(decideGate({ ...LIMITS, estimateUsd: 0.9, batch: { limitUsd: 15, spentUsd: 14.5, halted: false } })).toEqual(
      {
        pass: false,
        reasons: ["over_batch_limit"],
      },
    );
  });

  it("AC-019「之后全部」：前面已经有一条因批次限额停下，后面哪怕只要 $0.3 也停", () => {
    expect(decideGate({ ...LIMITS, estimateUsd: 0.3, batch: { limitUsd: 15, spentUsd: 14.5, halted: true } })).toEqual({
      pass: false,
      reasons: ["batch_halted"],
    });
  });

  it("批次已花 + 估价刚好等于批次限额 → 放行", () => {
    expect(decideGate({ ...LIMITS, estimateUsd: 0.5, batch: { limitUsd: 15, spentUsd: 14.5, halted: false } })).toEqual(
      {
        pass: true,
      },
    );
  });

  it("单条与批次同时超：两个原因都列出来", () => {
    expect(decideGate({ ...LIMITS, estimateUsd: 2, batch: { limitUsd: 15, spentUsd: 14, halted: false } })).toEqual({
      pass: false,
      reasons: ["over_item_limit", "over_batch_limit"],
    });
  });
});
