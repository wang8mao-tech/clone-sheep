import { describe, expect, it } from "vitest";
import { bootProfiles, COMPATIBLE, useProfileSandbox } from "./profiles-test-kit.js";

/** 档案怎么落到会话上（REQ-010「运行」，Task 10.2）：注入哪些变量、快照、沿用与兜底 */

useProfileSandbox();

const env = async () => ({ ...(await bootProfiles()), pe: await import("./profile-env.js") });

describe("档案 → 会话环境变量", () => {
  it("订阅（内置与指定模型）不注入任何变量", async () => {
    const b = await env();
    const sub = b.profiles.requireProfile("subscription");
    expect(b.pe.profileEnv(sub, undefined, null)).toEqual({});
    const sonnet = b.profiles.createProfile({
      ...COMPATIBLE,
      name: "订阅 · Sonnet",
      kind: "subscription",
      modelId: "claude-sonnet-5",
    });
    expect(b.pe.profileEnv(sonnet, undefined, "claude-sonnet-5")).toEqual({});
  });

  it("官方 key 只注入 ANTHROPIC_API_KEY（有快速模型再加 haiku 档）", async () => {
    const b = await env();
    const row = b.profiles.createProfile({
      ...COMPATIBLE,
      name: "官方",
      kind: "anthropic",
      fastModelId: "claude-haiku-4-5-20251001",
    });
    expect(b.pe.profileEnv(row, "sk-ant-x", "claude-sonnet-5")).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
    });
  });

  it("兼容端点：BASE_URL / AUTH_TOKEN / MODEL、opus 与 sonnet 映到主模型、haiku 映到快速模型（空则主模型）、关非必要外联", async () => {
    const b = await env();
    const row = b.profiles.createProfile(COMPATIBLE);
    expect(b.pe.profileEnv(row, "sk-deep", "deepseek-flash")).toEqual({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-deep",
      ANTHROPIC_MODEL: "deepseek-flash",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-flash",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-flash",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    const fast = b.profiles.updateProfile(row.id, { fastModelId: "deepseek-lite" });
    expect(b.pe.profileEnv(fast, "sk-deep", "deepseek-v4-pro")).toMatchObject({
      ANTHROPIC_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-lite",
    });
  });
});

describe("会话配置（session.ts）", () => {
  const base = { workspace: "C:/ws", pluginDir: "C:/plugin", maxBudgetUsd: 5, onIntercept: () => undefined };

  it("非订阅档案去掉本机订阅令牌，订阅档案留着；两个会话的环境各算各的，不碰 process.env", async () => {
    const { buildSessionOptions } = await import("./session.js");
    const before = JSON.stringify(process.env);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-subscription";
    try {
      const third = buildSessionOptions({
        ...base,
        profile: {
          env: { ANTHROPIC_BASE_URL: "http://a", ANTHROPIC_AUTH_TOKEN: "t-a" },
          subscription: false,
          webSearch: true,
        },
      });
      const sub = buildSessionOptions({ ...base, profile: { env: {}, subscription: true, webSearch: true } });
      const other = buildSessionOptions({
        ...base,
        profile: {
          env: { ANTHROPIC_BASE_URL: "http://b", ANTHROPIC_AUTH_TOKEN: "t-b" },
          subscription: false,
          webSearch: true,
        },
      });
      expect(third.env).toMatchObject({ ANTHROPIC_BASE_URL: "http://a", ANTHROPIC_AUTH_TOKEN: "t-a" });
      expect(third.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(other.env).toMatchObject({ ANTHROPIC_BASE_URL: "http://b", ANTHROPIC_AUTH_TOKEN: "t-b" });
      expect(sub.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-subscription");
      expect(sub.env?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    expect(JSON.stringify(process.env)).toBe(before);
  });

  it("没有原生联网搜索：禁用 WebSearch，系统提示里写怎么找图；有的不禁", async () => {
    const { buildSessionOptions } = await import("./session.js");
    const { NO_WEB_SEARCH } = await import("./prompts.js");
    const off = buildSessionOptions({ ...base, profile: { env: {}, subscription: false, webSearch: false } });
    expect(off.disallowedTools).toContain("WebSearch");
    expect(JSON.stringify(off.systemPrompt)).toContain(JSON.stringify(NO_WEB_SEARCH).slice(1, 40));
    const on = buildSessionOptions({ ...base, profile: { env: {}, subscription: false, webSearch: true } });
    expect(on.disallowedTools).not.toContain("WebSearch");
    expect(JSON.stringify(on.systemPrompt)).not.toContain("没有原生联网搜索");
  });
});

describe("建任务时的档案快照（jobProfile）", () => {
  it("不给档案用默认档案；花费口径按类型与单价", async () => {
    const b = await env();
    expect(b.pe.jobProfile({ ownerKind: "production" })).toEqual({
      profile_id: "subscription",
      profile_name: "本机 Claude Code 订阅",
      model_id: null,
      cost_basis: "sdk",
    });
    const priced = b.profiles.createProfile(COMPATIBLE);
    b.profiles.setDefaultProfile(priced.id);
    expect(b.pe.jobProfile({ ownerKind: "production" })).toMatchObject({
      profile_id: priced.id,
      model_id: "deepseek-flash",
      cost_basis: "price",
    });
    const free = b.profiles.createProfile({ ...COMPATIBLE, name: "无价", priceIn: null, priceOut: null });
    expect(b.pe.jobProfile({ ownerKind: "production", profileId: free.id }).cost_basis).toBe("none");
  });

  it("复刻（模板的任务）要看图；没 key 的档案谁都不能用；不存在的 404", async () => {
    const b = await env();
    const blind = b.profiles.createProfile({ ...COMPATIBLE, supportsVision: false });
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { code?: string }).code;
      }
      return "NO_ERROR";
    };
    expect(code(() => b.pe.jobProfile({ ownerKind: "template", profileId: blind.id }))).toBe("PROFILE_NO_VISION");
    expect(b.pe.jobProfile({ ownerKind: "production", profileId: blind.id }).profile_id).toBe(blind.id);
    b.secrets.setSecret(b.profiles.tokenKey(blind.id), null);
    expect(code(() => b.pe.jobProfile({ ownerKind: "production", profileId: blind.id }))).toBe("PROFILE_NO_TOKEN");
    expect(code(() => b.pe.jobProfile({ ownerKind: "production", profileId: "nope" }))).toBe("PROFILE_NOT_FOUND");
  });

  it("过渡做法：只给模型 id 记成内置订阅 + 这个模型；验的是订阅，不是默认档案（10.2 审查 S1-M1）", async () => {
    const b = await env();
    const blind = b.profiles.createProfile({ ...COMPATIBLE, supportsVision: false });
    b.profiles.setDefaultProfile(blind.id);
    b.secrets.setSecret(b.profiles.tokenKey(blind.id), null);
    expect(b.pe.jobProfile({ ownerKind: "template", legacyModelId: "claude-sonnet-5" }).profile_id).toBe(
      "subscription",
    );
    expect(b.pe.jobProfile({ ownerKind: "production", legacyModelId: "claude-sonnet-5" })).toEqual({
      profile_id: "subscription",
      profile_name: "本机 Claude Code 订阅",
      model_id: "claude-sonnet-5",
      cost_basis: "sdk",
    });
  });
});

describe("开跑时按快照与原档案算（runProfile）", () => {
  it("原档案删了或 key 没了：PROFILE_GONE；老任务（没记档案）按订阅 + 当时的模型", async () => {
    const b = await env();
    const row = b.profiles.createProfile(COMPATIBLE);
    const snap = { profile_id: row.id, profile_name: row.name, model_id: "deepseek-flash" };
    expect(b.pe.runProfile(snap)).toMatchObject({
      subscription: false,
      webSearch: true,
      basis: "price",
      pricing: { in: 0.27, out: 1.1 },
    });
    b.secrets.setSecret(b.profiles.tokenKey(row.id), null);
    expect(() => b.pe.runProfile(snap)).toThrow(expect.objectContaining({ code: "PROFILE_GONE" }));
    b.profiles.deleteProfile(row.id);
    expect(() => b.pe.runProfile(snap)).toThrow(expect.objectContaining({ code: "PROFILE_GONE" }));
    expect(b.pe.runProfile({ profile_id: null, profile_name: null, model_id: "claude-opus-5-5" })).toMatchObject({
      env: {},
      subscription: true,
      model: "claude-opus-5-5",
      basis: "sdk",
      pricing: null,
    });
  });

  it("用快照里的模型，不跟着档案后来改的模型走（resume 沿用原会话的模型）", async () => {
    const b = await env();
    const row = b.profiles.createProfile(COMPATIBLE);
    b.profiles.updateProfile(row.id, { modelId: "deepseek-v4-pro" });
    const run = b.pe.runProfile({ profile_id: row.id, profile_name: row.name, model_id: "deepseek-flash" });
    expect(run.model).toBe("deepseek-flash");
    expect(run.env.ANTHROPIC_MODEL).toBe("deepseek-flash");
  });
});

describe("重跑用哪个档案（rerunChoice）", () => {
  it("给了用给的；没给用原档案；原档案没了用默认；过渡任务沿用模型", async () => {
    const b = await env();
    const row = b.profiles.createProfile(COMPATIBLE);
    expect(b.pe.rerunChoice({ profile_id: row.id, model_id: "x" }, "other")).toEqual({ profileId: "other" });
    expect(b.pe.rerunChoice({ profile_id: row.id, model_id: "deepseek-flash" })).toEqual({ profileId: row.id });
    expect(b.pe.rerunChoice({ profile_id: "gone", model_id: "m" })).toEqual({});
    expect(b.pe.rerunChoice({ profile_id: null, model_id: "claude-sonnet-5" })).toEqual({ modelId: "claude-sonnet-5" });
    expect(b.pe.rerunChoice({ profile_id: "subscription", model_id: "claude-sonnet-5" })).toEqual({
      modelId: "claude-sonnet-5",
    });
    expect(b.pe.rerunChoice({ profile_id: "subscription", model_id: null })).toEqual({ profileId: "subscription" });
    // 没记档案、也没记模型的老任务：原档案就是订阅（与 runProfile 一致，10.2 审查 S1-L1）
    expect(b.pe.rerunChoice({ profile_id: null, model_id: null })).toEqual({ profileId: "subscription" });
  });
});

describe("消息里的凭据打码（redactSecrets）", () => {
  it("原文与 JSON 转义形式都换掉；没出现就原样返回同一个对象；太短的不当凭据", async () => {
    const { redactSecrets } = await import("./profile-env.js");
    const secret = 'sk-abc"def1234567';
    const msg = { type: "user", content: [{ text: `token=${secret}` }], raw: JSON.stringify({ k: secret }) };
    const out = redactSecrets(msg, [secret]);
    expect(JSON.stringify(out)).not.toContain("sk-abc");
    expect(out.content[0]!.text).toBe("token=••••••••••••");
    const clean = { type: "assistant", text: "hello" };
    expect(redactSecrets(clean, [secret])).toBe(clean);
    expect(redactSecrets({ t: "abc" }, ["abc"])).toEqual({ t: "abc" });
    // URL 编码后的样子（拼进查询串里带出来的）
    const plus = "sk+abc/12345678";
    expect(JSON.stringify(redactSecrets({ url: `https://x?k=${encodeURIComponent(plus)}` }, [plus]))).not.toContain(
      "sk%2B",
    );
  });
});

describe("会话里的 guard 保护 Claude Code 登录凭据（10.2 审查 S2-M2）", () => {
  it("PreToolUse 钩子拒绝读 ~/.claude/.credentials.json", async () => {
    const { buildSessionOptions } = await import("./session.js");
    const { homedir } = await import("node:os");
    const path = await import("node:path");
    const options = buildSessionOptions({
      workspace: "C:/ws",
      pluginDir: "C:/plugin",
      maxBudgetUsd: 5,
      onIntercept: () => undefined,
    });
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    const out = (await hook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: path.join(homedir(), ".claude", ".credentials.json") },
      } as never,
      undefined,
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("会话配置：流式事件开关", () => {
  it("要按单价折算的会话把 includePartialMessages 交给 SDK；不要的不带", async () => {
    const { buildSessionOptions } = await import("./session.js");
    const base = { workspace: "C:/ws", pluginDir: "C:/plugin", maxBudgetUsd: 5, onIntercept: () => undefined };
    expect(buildSessionOptions({ ...base, includePartialMessages: true }).includePartialMessages).toBe(true);
    expect(buildSessionOptions(base).includePartialMessages).toBeUndefined();
  });
});
