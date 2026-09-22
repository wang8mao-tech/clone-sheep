import { describe, expect, it } from "vitest";
import { deriveSteps, defaultStep, isStepKey, type StepInput, type StepKey, type StepState } from "./steps.js";

function states(over: Partial<StepInput> = {}): Record<StepKey, StepState> {
  const steps = deriveSteps({ status: "importing", evidenceStatus: "running", ...over });
  return Object.fromEntries(steps.map((s) => [s.key, s.state])) as Record<StepKey, StepState>;
}

describe("deriveSteps", () => {
  it("刚建出来在导入参考，后面四步全锁着", () => {
    expect(states({ status: "importing" })).toEqual({
      reference: "running",
      clone: "locked",
      review: "locked",
      variants: "locked",
      outputs: "locked",
    });
  });

  it("复刻中：①完成 ②进行中", () => {
    const s = states({ status: "cloning", evidenceStatus: "done" });
    expect(s.reference).toBe("done");
    expect(s.clone).toBe("running");
    expect(s.review).toBe("locked");
  });

  it("待验货是「需处理」而不是「可进入」——CMP-001 的琥珀点要给人看", () => {
    const s = states({ status: "awaiting_review", evidenceStatus: "done" });
    expect(s.clone).toBe("done");
    expect(s.review).toBe("attention");
  });

  /** SCOPE-004 / REQ-004：验货通过才解锁 ④变体 与 ⑤成片，同一道闸门 */
  it("没通过验货前，④变体 与 ⑤成片 都锁着", () => {
    for (const status of ["importing", "cloning", "awaiting_review", "failed"] as const) {
      const s = states({ status, evidenceStatus: "done" });
      expect(s.variants).toBe("locked");
      expect(s.outputs).toBe("locked");
    }
  });

  it("「通过」这一个动作同时解锁 ④变体 与 ⑤成片（AC-040）", () => {
    const s = states({ status: "approved", evidenceStatus: "done" });
    expect(s.review).toBe("done");
    expect(s.variants).toBe("available");
    expect(s.outputs).toBe("available");
  });

  it("失败落在哪一步按有没有参考视频判", () => {
    expect(states({ status: "failed", evidenceStatus: "failed" }).reference).toBe("failed");
    expect(states({ status: "failed", evidenceStatus: "done" }).reference).toBe("done");
    expect(states({ status: "failed", evidenceStatus: "done" }).clone).toBe("failed");
    // 重试进行中、模板状态还停在 failed：算 ①参考 进行中，不怪 ②复刻（Task 4.4 复审 HIGH）
    expect(states({ status: "failed", evidenceStatus: "running" }).reference).toBe("running");
    expect(states({ status: "failed", evidenceStatus: "running" }).clone).toBe("locked");
    // 模板还是 importing 但证据已失败（后端重启后）：①参考 标失败，不说进行中
    expect(states({ status: "importing", evidenceStatus: "failed" }).reference).toBe("failed");
    expect(states({ status: "importing", evidenceStatus: "running" }).reference).toBe("running");
    // 刚建好、还没提交视频：可进入，不说进行中
    expect(states({ status: "importing", evidenceStatus: "idle" }).reference).toBe("available");
  });

  /**
   * 曾经实现成「有成片就能进 ⑤」，与 FLOW-002 完成状态冲突——那里写明复刻片是在
   * 「已验货」那一刻才入库成片的。现在 ⑤ 只看闸门，不看片子数。
   */
  it("复刻片已出但还没验货时，⑤成片 仍然锁着", () => {
    expect(states({ status: "awaiting_review", evidenceStatus: "done" }).outputs).toBe("locked");
  });

  it("序号与名称按 Design-Brief 的五步顺序", () => {
    const steps = deriveSteps({ status: "approved", evidenceStatus: "done" });
    expect(steps.map((s) => `${s.index}${s.label}`)).toEqual(["1参考", "2复刻", "3验货", "4变体", "5成片"]);
  });

  it("只有未解锁的步骤不可点", () => {
    const steps = deriveSteps({ status: "awaiting_review", evidenceStatus: "done" });
    const locked = steps.filter((s) => !s.enterable).map((s) => s.key);
    expect(locked).toEqual(["variants", "outputs"]);
  });
});

describe("defaultStep", () => {
  const at = (over: Partial<StepInput>) =>
    defaultStep(deriveSteps({ status: "importing", evidenceStatus: "running", ...over }));

  it("需要人动手的优先——待验货时直接停在 ③", () => {
    expect(at({ status: "awaiting_review", evidenceStatus: "done" })).toBe("review");
  });

  /**
   * 上一条区分不开「需处理优先」和「取最后一个能进的」：待验货时 ③ 恰好就是
   * 最后一个能进的步骤，两条规则结果撞在一起，去掉前者照样全绿。
   * 这条让 ⑤ 也能进，把两者拉开。
   */
  it("后面还有能进的步骤时，仍然停在需处理那一步而不是最后一步", () => {
    expect(at({ status: "awaiting_review", evidenceStatus: "done" })).toBe("review");
  });

  it("没有待办就停在正在跑的那一步", () => {
    expect(at({ status: "cloning", evidenceStatus: "done" })).toBe("clone");
    expect(at({ status: "importing" })).toBe("reference");
  });

  it("失败时停在失败那一步，别让人自己找", () => {
    expect(at({ status: "failed", evidenceStatus: "done" })).toBe("clone");
    expect(at({ status: "failed", evidenceStatus: "failed" })).toBe("reference");
  });

  it("都完成了就停在能进的最后一步", () => {
    // 验货通过后 ④⑤ 同时解锁，能进的最后一步是 ⑤成片
    expect(at({ status: "approved", evidenceStatus: "done" })).toBe("outputs");
  });

  /**
   * 每一级都只在可进的步骤里挑。调用方的判据是「目标不可进就跳到这里」，
   * 这里要是能返回一个不可进的步骤，就会来回重定向、整页停在 <Navigate> 上。
   */
  it("永远不会返回一个进不去的步骤", () => {
    const cases: StepInput[] = [
      { status: "importing", evidenceStatus: "running" },
      { status: "cloning", evidenceStatus: "done" },
      { status: "awaiting_review", evidenceStatus: "done" },
      { status: "approved", evidenceStatus: "done" },
      { status: "failed", evidenceStatus: "failed" },
      { status: "failed", evidenceStatus: "done" },
    ];
    for (const input of cases) {
      const steps = deriveSteps(input);
      const key = defaultStep(steps);
      expect(steps.find((s) => s.key === key)?.enterable).toBe(true);
    }
  });

  it("一步都进不去时返回 undefined，而不是硬塞一个进不去的", () => {
    const allLocked = deriveSteps({ status: "importing", evidenceStatus: "running" }).map((s) => ({
      ...s,
      state: "locked" as const,
      enterable: false,
    }));
    expect(defaultStep(allLocked)).toBeUndefined();
  });
});

describe("isStepKey", () => {
  it("认得五个合法步骤", () => {
    expect(["reference", "clone", "review", "variants", "outputs"].every(isStepKey)).toBe(true);
  });

  it("地址里塞别的东西一律不认", () => {
    expect(isStepKey("settings")).toBe(false);
    expect(isStepKey("")).toBe(false);
    expect(isStepKey(undefined)).toBe(false);
  });
});
