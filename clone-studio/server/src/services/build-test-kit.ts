import { boot, until, type Booted } from "./clone-test-kit.js";

/** 出片执行器测试共用的假 plan、进度行与「判据通过 → 排队 → 估价 auto → 自动起片」的起手式 */

export const LOCAL_PLAN = {
  format: "hypit.cli-plan@1",
  ok: true,
  providerRequestCount: 0,
  unresolvedRequestCount: 0,
  unsupportedRequestCount: 0,
  providers: [
    {
      request: "r1",
      capability: "@hypit/render-hyperframes@1#render-visual",
      status: "resolved",
      endpoint: "hyperframes.local",
      pricing: { kind: "local" },
    },
  ],
  needs: [{ request: "r1", summary: { fields: { startFrame: 0, endFrameExclusive: 900, frameRate: "30/1" } } }],
  preflight: { ok: true, diagnostics: [] },
};

export const PROGRESS = [
  "· Working · 0/3 steps complete · 9s",
  "· Working · 1/3 steps complete · 1 rendering frames · 476/900 frames · 4m 41s",
  "· Saving Result · 1/3 steps complete · 8m 21s",
];

/** 判据通过 → 复刻片排队 → 估价（本地 $0，auto）→ 执行器自动起片；返回复刻片 id */
export async function released(b: Booted): Promise<string> {
  b.setPlan(LOCAL_PLAN);
  b.setStatus("cloning");
  b.clone.startClone(b.templateId);
  b.writeProducts();
  await b.finishRun();
  await until(() => b.clone.latestReplica(b.templateId) !== undefined, "复刻片建出来");
  const replica = b.clone.latestReplica(b.templateId) as { id: string };
  await until(() => b.estimate.currentEstimate(replica.id) !== undefined, "估价落库");
  return replica.id;
}

export const productionStatus = (b: Booted, id: string) =>
  (b.db().prepare("SELECT status FROM productions WHERE id = ?").get(id) as { status: string }).status;
export const templateStatus = (b: Booted) =>
  (b.db().prepare("SELECT status FROM templates WHERE id = ?").get(b.templateId) as { status: string }).status;

export { boot, until };
