import { describe, expect, it } from "vitest";
import { describeDiff } from "./review.js";

describe("describeDiff（SCREEN-005 两片差异一行）", () => {
  const ref = { duration: 13.9, width: 720, height: 1280 };
  it("有一路元数据没到：不显示", () => {
    expect(describeDiff(ref, undefined)).toBeNull();
    expect(describeDiff(undefined, ref)).toBeNull();
  });
  it("时长差带正负号与哪边长，分辨率不同时两个都写", () => {
    expect(describeDiff(ref, { duration: 13.2, width: 1080, height: 1920 })).toBe(
      "时长差 −0.7s（复刻片更短） · 分辨率 原片 720×1280 / 复刻片 1080×1920",
    );
  });
  it("差不到 0.05 秒算一致；分辨率一样只写一次", () => {
    expect(describeDiff(ref, { duration: 13.93, width: 720, height: 1280 })).toBe("时长一致 · 分辨率一致 720×1280");
  });
});
