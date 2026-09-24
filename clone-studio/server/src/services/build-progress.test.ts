import { describe, expect, it } from "vitest";
import { judgeBuild, parseProgressLine } from "./build-progress.js";

/** 进度行照 2026-09-23 实跑 `build --follow` 的 stderr 抄；成败 JSON 照 spike-notes 与 scratchpad/render/build1.json */

describe("parseProgressLine", () => {
  it("渲染中的行：阶段、步数、帧数、用时", () => {
    const p = parseProgressLine("  · Working · 1/3 steps complete · 1 rendering frames · 476/900 frames · 4m 41s");
    expect(p).toEqual({
      stage: "working",
      phase: "rendering frames",
      stepsDone: 1,
      stepsTotal: 3,
      unitsDone: 476,
      unitsTotal: 900,
      elapsed: "4m 41s",
      raw: "· Working · 1/3 steps complete · 1 rendering frames · 476/900 frames · 4m 41s",
    });
  });

  it("刚提交、编码、保存结果", () => {
    expect(parseProgressLine("  · Working · 0/3 steps complete · 9s")).toMatchObject({
      stage: "working",
      phase: null,
      elapsed: "9s",
    });
    const enc = parseProgressLine("  · Working · 1/3 steps complete · 1 encoding video · 7m 56s");
    expect(enc).toMatchObject({ phase: "encoding video", unitsDone: null });
    const save = parseProgressLine("  · Saving Result · 1/3 steps complete · 8m 21s");
    expect(save).toMatchObject({ stage: "saving" });
  });

  it("不是进度行（警告、空行）返回 null", () => {
    expect(parseProgressLine("[hyperframes] browserGpuMode probe → hardware")).toBeNull();
    expect(parseProgressLine("")).toBeNull();
    expect(parseProgressLine("· Nope · 1s")).toBeNull();
  });
});

describe("judgeBuild", () => {
  it("成功：result.outcome complete，带 id 与 targets", () => {
    expect(
      judgeBuild({
        format: "hypit.cli-build@1",
        build: {
          id: "bld_1",
          targets: ["export-part-1.video"],
          work: { state: "done", outcome: "complete" },
          result: { state: "complete", outputCount: 75 },
        },
      }),
    ).toEqual({ outcome: "complete", buildId: "bld_1", failure: null, targets: ["export-part-1.video"] });
  });

  it("失败：work.state 是 done 但 result 是 failed，failure 原文带出", () => {
    expect(
      judgeBuild({
        build: {
          id: "bld_2",
          targets: ["export-part-1.video"],
          failure: "Command need:… ended without a stored result: Rendered visual frame rate differs from its document",
          work: { state: "done", outcome: "failed" },
          result: { state: "failed", outputCount: 74 },
        },
      }),
    ).toMatchObject({ outcome: "failed", failure: expect.stringContaining("frame rate differs") });
  });

  it("「需要处理」（attention）：result 缺失是 unknown，attention.message 当失败原文", () => {
    const v = judgeBuild({
      build: {
        id: "bld_x",
        targets: ["reference.video"],
        attention: { message: "Endpoint hyperframes.local is not reachable" },
        result: { state: "missing" },
      },
    });
    expect(v).toMatchObject({ outcome: "unknown", failure: "Endpoint hyperframes.local is not reachable" });
  });

  it("result 缺失（build 还没 finish 就被打断）：unknown，不能当成功", () => {
    expect(judgeBuild({ build: { id: "bld_3", work: { state: "done" }, result: { state: "missing" } } })).toMatchObject(
      { outcome: "unknown" },
    );
    expect(judgeBuild(null)).toMatchObject({ outcome: "unknown", buildId: null });
  });
});
