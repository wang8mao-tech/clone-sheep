import { describe, expect, it } from "vitest";
import { boot, until, uploadFile, useCloneSandbox } from "./clone-test-kit.js";
import { bootVariants } from "./variant-test-kit.js";
import { inReview } from "./variant-review-kit.js";

/**
 * 档案在各个入口上（REQ-010，Task 10.2）：①参考 提交、证据做完自动起复刻、④ 提交、重跑重选
 */

useCloneSandbox();

const DEEPSEEK = {
  name: "DeepSeek",
  kind: "compatible" as const,
  baseUrl: "https://api.deepseek.com/anthropic",
  token: "sk-deepseek-1234567890abcd",
  modelId: "deepseek-flash",
  supportsVision: true,
  supportsWebSearch: true,
  priceIn: 1,
  priceOut: 2,
};

const profilesMod = () => import("../agent/profiles.js");

describe("①参考 提交", () => {
  it("选了不支持看图的档案：直接拒，模板不动、不起证据、不建任务（AC-027）", async () => {
    const b = await boot();
    const profiles = await profilesMod();
    const blind = profiles.createProfile({ ...DEEPSEEK, supportsVision: false });
    const before = b
      .db()
      .prepare("SELECT status, agent_profile_id, source_kind FROM templates WHERE id = ?")
      .get(b.templateId);
    await expect(
      b.evidence.startEvidence({
        templateId: b.templateId,
        source: { kind: "file", path: uploadFile() },
        language: "zh",
        profileId: blind.id,
      }),
    ).rejects.toMatchObject({ code: "PROFILE_NO_VISION" });
    expect(
      b.db().prepare("SELECT status, agent_profile_id, source_kind FROM templates WHERE id = ?").get(b.templateId),
    ).toEqual(before);
    expect(b.hypitCalls).toHaveLength(0);
    expect(b.db().prepare("SELECT COUNT(*) AS n FROM agent_jobs").get()).toEqual({ n: 0 });
  });

  it("选的档案记在模板上；证据做完起的复刻用它（AC-026 同路）", async () => {
    const b = await boot();
    const profiles = await profilesMod();
    const p = profiles.createProfile(DEEPSEEK);
    await b.evidence.startEvidence({
      templateId: b.templateId,
      source: { kind: "file", path: uploadFile() },
      language: "zh",
      profileId: p.id,
    });
    await until(() => b.calls.length > 0, "复刻开跑");
    expect(b.calls[0]!.input.profile?.env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(b.calls[0]!.input.model).toBe("deepseek-flash");
    const job = b.store.latestJobOf("template", b.templateId);
    expect(job).toMatchObject({
      profile_id: p.id,
      profile_name: "DeepSeek",
      model_id: "deepseek-flash",
      cost_basis: "price",
    });
  });

  it("导入之后档案被改成不支持看图：复刻用内置订阅起，快照照实记", async () => {
    const b = await boot();
    const profiles = await profilesMod();
    const p = profiles.createProfile(DEEPSEEK);
    b.db().prepare("UPDATE templates SET agent_profile_id = ? WHERE id = ?").run(p.id, b.templateId);
    profiles.updateProfile(p.id, { supportsVision: false });
    b.setStatus("cloning");
    const job = b.clone.startClone(b.templateId);
    expect(job).toMatchObject({ profile_id: "subscription", profile_name: "本机 Claude Code 订阅" });
  });

  it("不选档案：用当时的默认档案，同样验看图、同样记在模板上（10.2 审查 S1-M2）", async () => {
    const b = await boot();
    const profiles = await profilesMod();
    const blind = profiles.createProfile({ ...DEEPSEEK, name: "看不见", supportsVision: false });
    profiles.setDefaultProfile(blind.id);
    await expect(
      b.evidence.startEvidence({
        templateId: b.templateId,
        source: { kind: "file", path: uploadFile() },
        language: "zh",
      }),
    ).rejects.toMatchObject({ code: "PROFILE_NO_VISION" });
    const p = profiles.createProfile(DEEPSEEK);
    profiles.setDefaultProfile(p.id);
    await b.evidence.startEvidence({
      templateId: b.templateId,
      source: { kind: "file", path: uploadFile() },
      language: "zh",
    });
    expect(b.db().prepare("SELECT agent_profile_id FROM templates WHERE id = ?").get(b.templateId)).toEqual({
      agent_profile_id: p.id,
    });
    // 之后改默认不影响这一次
    profiles.setDefaultProfile("subscription");
    await until(() => b.calls.length > 0, "复刻开跑");
    expect(b.store.latestJobOf("template", b.templateId)).toMatchObject({ profile_id: p.id });
  });

  it("老模板（导入时还没有档案）：起复刻用默认档案，默认不支持看图就用订阅", async () => {
    const b = await boot();
    const profiles = await profilesMod();
    const blind = profiles.createProfile({ ...DEEPSEEK, supportsVision: false });
    profiles.setDefaultProfile(blind.id);
    b.setStatus("cloning");
    expect(b.clone.startClone(b.templateId)).toMatchObject({ profile_id: "subscription" });
  });
});

describe("④ 变体提交", () => {
  it("带档案：每条任务按档案记快照；不存在的档案：拒，不建批次也不复制文件", async () => {
    const v = await bootVariants();
    const profiles = await profilesMod();
    const p = profiles.createProfile({ ...DEEPSEEK, supportsVision: false });
    v.submit(["手机排行 A", "手机排行 B"], { profileId: p.id });
    const jobs = v
      .db()
      .prepare("SELECT profile_id, profile_name, model_id FROM agent_jobs WHERE owner_kind = 'production'")
      .all();
    expect(jobs).toEqual([
      { profile_id: p.id, profile_name: "DeepSeek", model_id: "deepseek-flash" },
      { profile_id: p.id, profile_name: "DeepSeek", model_id: "deepseek-flash" },
    ]);
    const batches = () => (v.db().prepare("SELECT COUNT(*) AS n FROM batches").get() as { n: number }).n;
    const count = batches();
    expect(() => v.submit(["手机排行 C"], { profileId: "nope" })).toThrow(
      expect.objectContaining({ code: "PROFILE_NOT_FOUND" }),
    );
    expect(batches()).toBe(count);
  });

  it("老接口只给模型 id：仍走内置订阅 + 这个模型", async () => {
    const v = await bootVariants();
    v.submit(["手机排行 A"], { modelId: "claude-sonnet-5" });
    expect(v.db().prepare("SELECT profile_id, model_id FROM agent_jobs").get()).toEqual({
      profile_id: "subscription",
      model_id: "claude-sonnet-5",
    });
  });
});

describe("POST /api/agent-jobs/:jobId/rerun 带档案", () => {
  async function app() {
    const Fastify = (await import("fastify")).default;
    const { agentJobRoutes } = await import("../routes/agent-jobs.js");
    const server = Fastify();
    await server.register(agentJobRoutes);
    return server;
  }

  it("变体重跑换档案：新任务用选的档案；选的不存在：404，变体的素材不动", async () => {
    const b = await bootVariants();
    const { id } = await inReview(b);
    const profiles = await profilesMod();
    const p = profiles.createProfile(DEEPSEEK);
    const server = await app();
    const first = b.store.latestJobOf("production", id)!;
    const assets = b.vstore.listAssets(id).length;
    const missing = await server.inject({
      method: "POST",
      url: `/api/agent-jobs/${first.id}/rerun`,
      payload: { profileId: "nope" },
    });
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, "PROFILE_NOT_FOUND"]);
    expect(b.vstore.listAssets(id)).toHaveLength(assets);
    const res = await server.inject({
      method: "POST",
      url: `/api/agent-jobs/${first.id}/rerun`,
      payload: { profileId: p.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({
      profileId: p.id,
      profileName: "DeepSeek",
      modelId: "deepseek-flash",
      costBasis: "price",
    });
    await server.close();
  });
});
