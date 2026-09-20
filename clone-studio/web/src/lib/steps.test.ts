import { describe, expect, it } from "vitest";
import { deriveSteps, defaultStep, isStepKey, type StepInput, type StepKey, type StepState } from "./steps.js";

function states(over: Partial<StepInput> = {}): Record<StepKey, StepState> {
  const steps = deriveSteps({ status: "importing", hasSource: false, outputs: 0, ...over });
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
    const s = states({ status: "cloning", hasSource: true });
    expect(s.reference).toBe("done");
    expect(s.clone).toBe("running");
    expect(s.review).toBe("locked");
  });

  it("待验货是「需处理」而不是「可进入」——CMP-001 的琥珀点要给人看", () => {
    const s = states({ status: "awaiting_review", hasSource: true });
    expect(s.clone).toBe("done");
    expect(s.review).toBe("attention");
  });

  /** SCOPE-004：验货通过才解锁变体 */
  it("没通过验货前，④变体一直锁着", () => {
    for (const status of ["importing", "cloning", "awaiting_review", "failed"] as const) {
      expect(states({ status, hasSource: true }).variants).toBe("locked");
    }
  });

  it("通过验货后 ④变体解锁", () => {
    const s = states({ status: "approved", hasSource: true });
    expect(s.review).toBe("done");
    expect(s.variants).toBe("available");
  });

  it("失败落在哪一步按有没有参考视频判", () => {
    expect(states({ status: "failed", hasSource: false }).reference).toBe("failed");
    expect(states({ status: "failed", hasSource: true }).reference).toBe("done");
    expect(states({ status: "failed", hasSource: true }).clone).toBe("failed");
  });

  it("有成片就能进 ⑤，不必等验货通过——复刻片本身也是成片", () => {
    expect(states({ status: "cloning", hasSource: true, outputs: 0 }).outputs).toBe("locked");
    expect(states({ status: "cloning", hasSource: true, outputs: 1 }).outputs).toBe("available");
  });

  it("outputs 不会把已经完成的步骤改回可进入", () => {
    const s = states({ status: "approved", hasSource: true, outputs: 3 });
    expect(s.review).toBe("done");
    expect(s.outputs).toBe("available");
  });

  it("序号与名称按 Design-Brief 的五步顺序", () => {
    const steps = deriveSteps({ status: "approved", hasSource: true, outputs: 0 });
    expect(steps.map((s) => `${s.index}${s.label}`)).toEqual(["1参考", "2复刻", "3验货", "4变体", "5成片"]);
  });

  it("只有未解锁的步骤不可点", () => {
    const steps = deriveSteps({ status: "awaiting_review", hasSource: true, outputs: 0 });
    const locked = steps.filter((s) => !s.enterable).map((s) => s.key);
    expect(locked).toEqual(["variants", "outputs"]);
  });
});

describe("defaultStep", () => {
  const at = (over: Partial<StepInput>) =>
    defaultStep(deriveSteps({ status: "importing", hasSource: false, outputs: 0, ...over }));

  it("需要人动手的优先——待验货时直接停在 ③", () => {
    expect(at({ status: "awaiting_review", hasSource: true })).toBe("review");
  });

  /**
   * 上一条区分不开「需处理优先」和「取最后一个能进的」：待验货时 ③ 恰好就是
   * 最后一个能进的步骤，两条规则结果撞在一起，去掉前者照样全绿。
   * 这条让 ⑤ 也能进，把两者拉开。
   */
  it("后面还有能进的步骤时，仍然停在需处理那一步而不是最后一步", () => {
    expect(at({ status: "awaiting_review", hasSource: true, outputs: 2 })).toBe("review");
  });

  it("没有待办就停在正在跑的那一步", () => {
    expect(at({ status: "cloning", hasSource: true })).toBe("clone");
    expect(at({ status: "importing" })).toBe("reference");
  });

  it("失败时停在失败那一步，别让人自己找", () => {
    expect(at({ status: "failed", hasSource: true })).toBe("clone");
    expect(at({ status: "failed", hasSource: false })).toBe("reference");
  });

  it("都完成了就停在能进的最后一步", () => {
    expect(at({ status: "approved", hasSource: true, outputs: 2 })).toBe("outputs");
    expect(at({ status: "approved", hasSource: true, outputs: 0 })).toBe("variants");
  });

  /**
   * 每一级都只在可进的步骤里挑。调用方的判据是「目标不可进就跳到这里」，
   * 这里要是能返回一个不可进的步骤，就会来回重定向、整页停在 <Navigate> 上。
   */
  it("永远不会返回一个进不去的步骤", () => {
    const cases: StepInput[] = [
      { status: "importing", hasSource: false, outputs: 0 },
      { status: "cloning", hasSource: true, outputs: 0 },
      { status: "awaiting_review", hasSource: true, outputs: 0 },
      { status: "approved", hasSource: true, outputs: 5 },
      { status: "failed", hasSource: false, outputs: 0 },
      { status: "failed", hasSource: true, outputs: 3 },
    ];
    for (const input of cases) {
      const steps = deriveSteps(input);
      const key = defaultStep(steps);
      expect(steps.find((s) => s.key === key)?.enterable).toBe(true);
    }
  });

  it("一步都进不去时返回 undefined，而不是硬塞一个进不去的", () => {
    const allLocked = deriveSteps({ status: "importing", hasSource: false, outputs: 0 }).map((s) => ({
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
