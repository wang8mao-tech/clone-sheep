import { describe, expect, it } from "vitest";
import {
  checkProbe,
  nextStep,
  pipelineStatus,
  transcribeNote,
  type ProbeFacts,
  type StepView,
} from "./evidence-rules.js";

function facts(over: Partial<ProbeFacts> = {}): ProbeFacts {
  return { duration: 30, hasVideo: true, hasAudio: true, width: 1080, height: 1920, frameRate: 30, ...over };
}

function steps(...pairs: Array<[StepView["step"], StepView["status"]]>): StepView[] {
  return pairs.map(([step, status]) => ({ step, status }));
}

describe("checkProbe", () => {
  it("正常的 30 秒竖屏片子放行", () => {
    expect(checkProbe(facts())).toEqual({ ok: true });
  });

  /** AC-005：200 秒视频，探测后提示「时长超过 180 秒」，不启动 Agent */
  it("超过 180 秒时说清上限与实际值（AC-005）", () => {
    const result = checkProbe(facts({ duration: 200 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DURATION_TOO_LONG");
    expect(result.message).toContain("180");
    expect(result.message).toContain("200.0");
  });

  it("边界：正好 180 秒放行，180.1 秒不放行", () => {
    expect(checkProbe(facts({ duration: 180 })).ok).toBe(true);
    expect(checkProbe(facts({ duration: 180.1 })).ok).toBe(false);
  });

  it("边界：正好 3 秒放行，2.9 秒不放行", () => {
    expect(checkProbe(facts({ duration: 3 })).ok).toBe(true);
    expect(checkProbe(facts({ duration: 2.9 })).ok).toBe(false);
  });

  it("没有视频轨直接挡掉，别让它走到转写再失败在看不懂的地方", () => {
    const result = checkProbe(facts({ hasVideo: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_VIDEO_STREAM");
  });

  it("时长探测不出来时说文件可能坏了，而不是当成 0 秒太短", () => {
    for (const duration of [0, Number.NaN, -1]) {
      const result = checkProbe(facts({ duration }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("BAD_DURATION");
    }
  });

  it("没有音轨不算错——静音片子照样能复刻画面", () => {
    expect(checkProbe(facts({ hasAudio: false })).ok).toBe(true);
    expect(transcribeNote(facts({ hasAudio: false }))).toContain("没有音轨");
    expect(transcribeNote(facts({ hasAudio: true }))).toBeUndefined();
  });
});

describe("pipelineStatus", () => {
  it("一步都没开始是 idle", () => {
    expect(pipelineStatus([])).toBe("idle");
    expect(pipelineStatus(steps(["fetch", "pending"], ["probe", "pending"]))).toBe("idle");
  });

  it("四步全 done 才算 done", () => {
    expect(pipelineStatus(steps(["fetch", "done"], ["probe", "done"], ["transcribe", "done"], ["tiles", "done"]))).toBe(
      "done",
    );
    expect(
      pipelineStatus(steps(["fetch", "done"], ["probe", "done"], ["transcribe", "done"], ["tiles", "pending"])),
    ).toBe("running");
  });

  /** REQ-002 错误态：哪一步失败停在哪一步——后面的步骤不该显示成"还没轮到" */
  it("有一步失败整体就是失败，哪怕后面还挂着 pending", () => {
    expect(
      pipelineStatus(steps(["fetch", "done"], ["probe", "failed"], ["transcribe", "pending"], ["tiles", "pending"])),
    ).toBe("failed");
  });

  it("超时和失败一样算失败", () => {
    expect(pipelineStatus(steps(["fetch", "done"], ["transcribe", "timeout"]))).toBe("failed");
  });
});

describe("nextStep", () => {
  it("按顺序给下一个待跑的", () => {
    expect(nextStep(steps(["fetch", "done"], ["probe", "pending"], ["transcribe", "pending"]))).toBe("probe");
  });

  it("失败时返回失败那一步本身——重试就是从它接着来", () => {
    expect(nextStep(steps(["fetch", "done"], ["probe", "failed"], ["transcribe", "pending"]))).toBe("probe");
  });

  it("全做完了就没有下一步", () => {
    expect(
      nextStep(steps(["fetch", "done"], ["probe", "done"], ["transcribe", "done"], ["tiles", "done"])),
    ).toBeUndefined();
  });
});
