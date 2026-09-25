import { describe, expect, it } from "vitest";
import { flush, init, job, setup, success, useTempDataRoot } from "./scheduler-test-kit.js";

/** 调度器按档案跑（REQ-010，Task 10.2）：注入、沿用原档案、重跑重选、单价熔断 */

useTempDataRoot();

const DEEPSEEK = {
  name: "DeepSeek",
  kind: "compatible" as const,
  baseUrl: "https://api.deepseek.com/anthropic",
  token: "sk-deepseek-1234567890abcd",
  modelId: "deepseek-flash",
  supportsVision: true,
  supportsWebSearch: false,
  priceIn: 1,
  priceOut: 1,
};

async function withProfiles() {
  const s = await setup();
  const profiles = await import("./profiles.js");
  const secrets = await import("../lib/secrets.js");
  return { ...s, profiles, secrets };
}

const assistant = (id: string, input: number, output: number) => ({
  type: "assistant",
  message: { id, content: [], usage: { input_tokens: input, output_tokens: output } },
});

describe("开跑：会话拿到档案的环境与模型", () => {
  it("默认订阅：不注入、不指定模型、SDK 预算照设置；任务记下档案名", async () => {
    const { scheduler, calls, store } = await withProfiles();
    const j = scheduler.enqueue(job("t1"));
    expect(calls[0]!.input.profile).toEqual({ env: {}, subscription: true, webSearch: true });
    expect(calls[0]!.input.model).toBeUndefined();
    expect(calls[0]!.input.maxBudgetUsd).toBe(5);
    expect(store.requireJob(j.id)).toMatchObject({
      profile_id: "subscription",
      profile_name: "本机 Claude Code 订阅",
      cost_basis: "sdk",
    });
  });

  it("兼容端点：注入变量、传模型、SDK 预算关掉（改由单价熔断）、无原生搜索", async () => {
    const { scheduler, calls, profiles } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    scheduler.enqueue({ ...job("t1"), profileId: p.id });
    expect(calls[0]!.input.model).toBe("deepseek-flash");
    expect(calls[0]!.input.profile).toMatchObject({
      subscription: false,
      webSearch: false,
      env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: DEEPSEEK.token },
    });
    expect(calls[0]!.input.maxBudgetUsd).toBe(1_000_000);
  });

  it("同时跑的两个任务：一个订阅、一个兼容端点，各拿各的环境", async () => {
    const { scheduler, calls, profiles } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    scheduler.enqueue({ ...job("t1"), profileId: p.id });
    scheduler.enqueue(job("t2"));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.input.profile?.env.ANTHROPIC_AUTH_TOKEN).toBe(DEEPSEEK.token);
    expect(calls[1]!.input.profile?.env).toEqual({});
  });

  it("复刻选了不支持看图的档案：拒，不建任务（AC-027）", async () => {
    const { scheduler, calls, profiles, store } = await withProfiles();
    const p = profiles.createProfile({ ...DEEPSEEK, supportsVision: false });
    expect(() => scheduler.enqueue({ ...job("t1"), profileId: p.id })).toThrow(
      expect.objectContaining({ code: "PROFILE_NO_VISION" }),
    );
    expect(calls).toHaveLength(0);
    expect(store.latestJobOf("template", "t1")).toBeUndefined();
    // 变体不要求看图
    scheduler.enqueue({ ownerKind: "production", ownerId: "v1", prompt: "写", profileId: p.id });
    expect(calls).toHaveLength(1);
  });
});

describe("花费口径", () => {
  it("按单价折算：到上限就熔断，花费记折算值，SDK 的累计值不认", async () => {
    const { scheduler, calls, profiles, store } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    const j = scheduler.enqueue({ ...job("t1"), profileId: p.id });
    calls[0]!.emit(init("s-1"));
    calls[0]!.emit(assistant("m1", 2_000_000, 1_000_000)); // $3
    await flush();
    expect(store.requireJob(j.id).status).toBe("running");
    calls[0]!.emit(assistant("m2", 1_000_000, 1_500_000)); // 再 $2.5，累计 5.5 ≥ $5
    await flush();
    expect(store.requireJob(j.id)).toMatchObject({ status: "tripped", cost_basis: "price" });
    expect(store.requireJob(j.id).stop_reason).toContain("按档案单价折算");
    expect(store.requireJob(j.id).cost_usd).toBeCloseTo(5.5);
  });

  it("按单价折算：继续之后叠在已记下的花费上", async () => {
    const { scheduler, calls, profiles, store } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    const j = scheduler.enqueue({ ...job("t1"), profileId: p.id });
    calls[0]!.emit(init("s-1"));
    calls[0]!.emit(assistant("m1", 1_000_000, 0));
    await scheduler.abort(j.id);
    expect(store.requireJob(j.id).cost_usd).toBeCloseTo(1);
    scheduler.continueJob(j.id);
    calls[1]!.emit(init("s-1"));
    calls[1]!.emit(assistant("m9", 500_000, 0));
    calls[1]!.emit(success(42));
    calls[1]!.finish({ result: success(42) as never });
    await flush();
    expect(store.requireJob(j.id).cost_usd).toBeCloseTo(1.5);
  });

  it("按单价折算：已经跑完的一段靠 result 的合计用量补齐输出 token；超了也不回头判熔断", async () => {
    const { scheduler, calls, profiles, store } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    const j = scheduler.enqueue({ ...job("t1"), profileId: p.id });
    calls[0]!.emit(init("s-1"));
    // 流式下 assistant 只记了 1 个输出 token（假端点实测）
    calls[0]!.emit(assistant("m1", 1_000_000, 1));
    const done = {
      type: "result",
      subtype: "success",
      total_cost_usd: 40,
      usage: { input_tokens: 1_000_000, output_tokens: 5_000_000 },
      errors: [],
    };
    calls[0]!.emit(done);
    calls[0]!.finish({ result: done as never });
    await flush();
    expect(store.requireJob(j.id)).toMatchObject({ status: "done" });
    expect(store.requireJob(j.id).cost_usd).toBeCloseTo(6);
  });

  it("没填单价：不做 $ 熔断，花费记 0、口径 none", async () => {
    const { scheduler, calls, profiles, store } = await withProfiles();
    const p = profiles.createProfile({ ...DEEPSEEK, priceIn: null, priceOut: null });
    const j = scheduler.enqueue({ ...job("t1"), profileId: p.id });
    calls[0]!.emit(init("s-1"));
    calls[0]!.emit(assistant("m1", 90_000_000, 90_000_000));
    calls[0]!.emit(success(7));
    calls[0]!.finish({ result: success(7) as never });
    await flush();
    expect(store.requireJob(j.id)).toMatchObject({ status: "done", cost_usd: 0, cost_basis: "none" });
  });
});

describe("继续、重跑与原档案", () => {
  it("继续沿用原档案；原档案删了：继续拒（只能重跑），重跑可重选，选的不能用就在清文件之前拒", async () => {
    const { scheduler, calls, profiles, store, resets } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    const j = scheduler.enqueue({ ...job("t1"), profileId: p.id });
    calls[0]!.emit(init("s-1"));
    await scheduler.abort(j.id);
    scheduler.continueJob(j.id);
    expect(calls[1]!.input.profile?.env.ANTHROPIC_AUTH_TOKEN).toBe(DEEPSEEK.token);
    await scheduler.abort(j.id);

    profiles.deleteProfile(p.id);
    expect(() => scheduler.continueJob(j.id)).toThrow(expect.objectContaining({ code: "PROFILE_GONE" }));
    expect(store.requireJob(j.id).status).toBe("interrupted");

    const blind = profiles.createProfile({ ...DEEPSEEK, name: "看不见", supportsVision: false });
    expect(() => scheduler.rerun(j.id, blind.id)).toThrow(expect.objectContaining({ code: "PROFILE_NO_VISION" }));
    expect(resets).toEqual([]);

    const next = scheduler.rerun(j.id, "subscription");
    expect(resets).toEqual([j.id]);
    expect(next).toMatchObject({ profile_id: "subscription", profile_name: "本机 Claude Code 订阅" });
    // 历史任务的快照不变（AC-030）
    expect(store.requireJob(j.id)).toMatchObject({ profile_name: "DeepSeek", model_id: "deepseek-flash" });
  });

  it("等额度期间档案删不掉（任务还在用）；key 被清了：到点续跑改判失败，写明原因", async () => {
    const { scheduler, calls, profiles, secrets, store, clock } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    const j = scheduler.enqueue({ ...job("t1"), profileId: p.id });
    calls[0]!.emit(init("s-1"));
    calls[0]!.emit({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: Math.floor((clock.now() + 120_000) / 1000) },
    });
    await flush();
    expect(store.requireJob(j.id).status).toBe("awaiting_quota");
    expect(() => profiles.deleteProfile(p.id)).toThrow(expect.objectContaining({ code: "PROFILE_IN_USE" }));
    secrets.setSecret(profiles.tokenKey(p.id), null);
    clock.advance(10 * 60_000);
    await flush();
    expect(calls).toHaveLength(1);
    expect(store.requireJob(j.id).status).toBe("failed");
    expect(store.requireJob(j.id).stop_reason).toContain("API key 没了");
  });
});

describe("消息流里的凭据", () => {
  it("Agent 想办法把 token 打进了消息：转出去（落库、推界面）之前就打码", async () => {
    const { scheduler, calls, profiles, forwardedMessages } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    scheduler.enqueue({ ...job("t1"), profileId: p.id });
    calls[0]!.emit(init("s-1"));
    calls[0]!.emit({
      type: "user",
      message: { content: [{ type: "tool_result", content: `TOKEN=${DEEPSEEK.token}` }] },
    });
    await flush();
    expect(JSON.stringify(forwardedMessages)).not.toContain(DEEPSEEK.token);
    expect(JSON.stringify(forwardedMessages)).toContain("TOKEN=••••");
  });
});

describe("停因里的凭据", () => {
  it("会话出错时 stderr 带出了 token：记进 stop_reason 之前打码", async () => {
    const { scheduler, calls, profiles, store } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    const j = scheduler.enqueue({ ...job("t1"), profileId: p.id });
    calls[0]!.finish({ error: `401 Unauthorized: Bearer ${DEEPSEEK.token}` });
    await flush();
    expect(store.requireJob(j.id).status).toBe("failed");
    expect(store.requireJob(j.id).stop_reason).not.toContain(DEEPSEEK.token);
  });
});

describe("拦截记录里的凭据", () => {
  it("被拦的命令里带着 token：记拦截之前打码", async () => {
    const { scheduler, calls, profiles, intercepts } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    scheduler.enqueue({ ...job("t1"), profileId: p.id });
    calls[0]!.input.onIntercept({
      rule: "protected-path",
      detail: `curl -H "x: ${DEEPSEEK.token}"`,
      reason: "拦",
      tool: "Bash",
    });
    expect(JSON.stringify(intercepts)).not.toContain(DEEPSEEK.token);
  });
});

describe("流式事件（10.4 审查 S2-M2）", () => {
  const ev = (event: Record<string, unknown>) => ({ type: "stream_event", event, parent_tool_use_id: null });

  it("按单价算的会话开流式事件；运行中输出 token 超了预算就熔断；流式事件不转出去（不落库、不推界面）", async () => {
    const { scheduler, calls, profiles, store, forwardedMessages } = await withProfiles();
    const p = profiles.createProfile(DEEPSEEK);
    const j = scheduler.enqueue({ ...job("t1"), profileId: p.id });
    expect(calls[0]!.input.includePartialMessages).toBe(true);
    calls[0]!.emit(init("s-1"));
    calls[0]!.emit(
      ev({ type: "message_start", message: { id: "m1", usage: { input_tokens: 1_000_000, output_tokens: 1 } } }),
    );
    await flush();
    expect(store.requireJob(j.id).status).toBe("running");
    calls[0]!.emit(ev({ type: "message_delta", usage: { output_tokens: 5_000_000 } }));
    await flush();
    expect(store.requireJob(j.id)).toMatchObject({ status: "tripped" });
    expect(store.requireJob(j.id).cost_usd).toBeCloseTo(6);
    expect(forwardedMessages.some((f) => (f.message as { type: string }).type === "stream_event")).toBe(false);
  });

  it("订阅与没填单价的：不开流式事件", async () => {
    const { scheduler, calls, profiles } = await withProfiles();
    scheduler.enqueue(job("t1"));
    const free = profiles.createProfile({ ...DEEPSEEK, name: "无价", priceIn: null, priceOut: null });
    scheduler.enqueue({ ...job("t2"), profileId: free.id });
    expect(calls[0]!.input.includePartialMessages).toBeUndefined();
    expect(calls[1]!.input.includePartialMessages).toBeUndefined();
  });
});
