import { describe, expect, it } from "vitest";
import type { ProbeResult } from "../agent/profile-test.js";
import type { ProfileRow } from "../agent/profiles.js";
import { bootProfiles, COMPATIBLE, useProfileSandbox } from "../agent/profiles-test-kit.js";

/** 模型档案接口（REQ-010、SCREEN-009）：响应里绝不出现明文 token */

useProfileSandbox();

async function app(probe?: (row: ProfileRow) => Promise<ProbeResult>) {
  const b = await bootProfiles();
  const Fastify = (await import("fastify")).default;
  const { modelProfileRoutes } = await import("./model-profiles.js");
  const server = Fastify();
  await server.register(modelProfileRoutes, probe ? { probe } : {});
  return { server, b };
}

describe("列表与预设", () => {
  it("空态只有内置订阅；预设带「需要 API key，聊天订阅不可用」与核实过的端点", async () => {
    const { server } = await app();
    const list = (await server.inject({ url: "/api/model-profiles" })).json();
    expect(list.profiles.map((p: { id: string }) => p.id)).toEqual(["subscription"]);
    const presets = (await server.inject({ url: "/api/model-profiles/presets" })).json();
    expect(presets.note).toBe("需要 API key，聊天订阅不可用");
    const byId = Object.fromEntries(presets.presets.map((p: { id: string; baseUrl: string }) => [p.id, p.baseUrl]));
    expect(byId).toMatchObject({
      deepseek: "https://api.deepseek.com/anthropic",
      ark: "https://ark.cn-beijing.volces.com/api/coding",
      "litellm-gemini": "http://127.0.0.1:4000",
      "litellm-openai": "http://127.0.0.1:4000",
      anthropic: null,
    });
    await server.close();
  });
});

describe("增删改", () => {
  it("新建 201、改、设默认、删：每个响应都不含明文 token", async () => {
    const { server } = await app();
    const bodies: string[] = [];
    const created = await server.inject({ method: "POST", url: "/api/model-profiles", payload: COMPATIBLE });
    bodies.push(created.body);
    expect(created.statusCode).toBe(201);
    const id = created.json().profile.id as string;
    expect(created.json().profile.token).toMatch(/^sk-•+abcd$/);
    const patched = await server.inject({ method: "PATCH", url: `/api/model-profiles/${id}`, payload: { name: "DS" } });
    bodies.push(patched.body);
    expect(patched.json().profile.name).toBe("DS");
    bodies.push((await server.inject({ method: "POST", url: `/api/model-profiles/${id}/default` })).body);
    bodies.push((await server.inject({ url: "/api/model-profiles" })).body);
    expect((await server.inject({ method: "DELETE", url: `/api/model-profiles/${id}` })).json()).toEqual({ ok: true });
    for (const body of bodies) expect(body).not.toContain(COMPATIBLE.token);
    await server.close();
  });

  it("业务错误照 code 回：重名 409、形状不对 400、内置的不能删 409、不存在 404", async () => {
    const { server } = await app();
    await server.inject({ method: "POST", url: "/api/model-profiles", payload: COMPATIBLE });
    const dup = await server.inject({ method: "POST", url: "/api/model-profiles", payload: COMPATIBLE });
    expect([dup.statusCode, dup.json().error.code]).toEqual([409, "NAME_TAKEN"]);
    const shape = await server.inject({ method: "POST", url: "/api/model-profiles", payload: { name: "x" } });
    expect([shape.statusCode, shape.json().error.code]).toEqual([400, "INVALID_BODY"]);
    const kind = await server.inject({
      method: "POST",
      url: "/api/model-profiles",
      payload: { ...COMPATIBLE, name: "x", kind: "openai" },
    });
    expect(kind.statusCode).toBe(400);
    // 「本机订阅 · 指定模型」不用 token
    const sub = await server.inject({
      method: "POST",
      url: "/api/model-profiles",
      payload: {
        name: "订阅 · Sonnet",
        kind: "subscription",
        modelId: "claude-sonnet-5",
        supportsVision: true,
        supportsWebSearch: true,
      },
    });
    expect([sub.statusCode, sub.json().profile.kind, sub.json().profile.token]).toEqual([201, "subscription", null]);
    const builtin = await server.inject({ method: "DELETE", url: "/api/model-profiles/subscription" });
    expect([builtin.statusCode, builtin.json().error.code]).toEqual([409, "BUILTIN_UNDELETABLE"]);
    const missing = await server.inject({ method: "POST", url: "/api/model-profiles/nope/test" });
    expect(missing.statusCode).toBe(404);
    await server.close();
  });
});

describe("测试连接", () => {
  it("失败：回上游原文，档案标未验证；成功：标已验证时间（AC-028）", async () => {
    let next: ProbeResult = { ok: false, status: 401, detail: '{"error":"invalid key"}' };
    const { server, b } = await app(async () => next);
    const id = (await server.inject({ method: "POST", url: "/api/model-profiles", payload: COMPATIBLE })).json().profile
      .id as string;
    b.profiles.markVerified(id, "2026-01-01T00:00:00.000Z");
    const failed = (await server.inject({ method: "POST", url: `/api/model-profiles/${id}/test` })).json();
    expect(failed.result).toEqual(next);
    expect(failed.profile.verifiedAt).toBeNull();

    next = { ok: true, status: 200 };
    const passed = (await server.inject({ method: "POST", url: `/api/model-profiles/${id}/test` })).json();
    expect(passed.stale).toBe(false);
    expect(Date.parse(passed.profile.verifiedAt as string)).toBeGreaterThan(Date.parse("2026-09-01"));
    await server.close();
  });

  it("测试途中档案被改了：结论不落到新配置上", async () => {
    let release: (r: ProbeResult) => void = () => {};
    const { server } = await app(() => new Promise((r) => (release = r)));
    const id = (await server.inject({ method: "POST", url: "/api/model-profiles", payload: COMPATIBLE })).json().profile
      .id as string;
    const pending = server.inject({ method: "POST", url: `/api/model-profiles/${id}/test` });
    await new Promise((r) => setTimeout(r, 20));
    await server.inject({ method: "PATCH", url: `/api/model-profiles/${id}`, payload: { modelId: "deepseek-v4-pro" } });
    release({ ok: true, status: 200 });
    const res = (await pending).json();
    expect(res.stale).toBe(true);
    expect(res.profile.verifiedAt).toBeNull();
    await server.close();
  });

  it("改过之后再点测试：不搭旧配置那次的车，新配置自己测（10.1 审查 M1）", async () => {
    const releases: Array<(r: ProbeResult) => void> = [];
    const models: Array<string | null> = [];
    const { server } = await app((row) => {
      models.push(row.model_id);
      return new Promise((r) => releases.push(r));
    });
    const id = (await server.inject({ method: "POST", url: "/api/model-profiles", payload: COMPATIBLE })).json().profile
      .id as string;
    const first = server.inject({ method: "POST", url: `/api/model-profiles/${id}/test` });
    await new Promise((r) => setTimeout(r, 20));
    await server.inject({ method: "PATCH", url: `/api/model-profiles/${id}`, payload: { modelId: "wrong-model" } });
    const second = server.inject({ method: "POST", url: `/api/model-profiles/${id}/test` });
    await new Promise((r) => setTimeout(r, 20));
    expect(models).toEqual(["deepseek-flash", "wrong-model"]);
    releases[0]!({ ok: true, status: 200 });
    expect((await first).json()).toMatchObject({ stale: true, profile: { verifiedAt: null } });
    releases[1]!({ ok: false, status: 404, detail: "model not found" });
    expect((await second).json()).toMatchObject({ stale: false, profile: { verifiedAt: null } });
    await server.close();
  });

  it("同一档案连点两下：只测一次", async () => {
    let calls = 0;
    let release: (r: ProbeResult) => void = () => {};
    const { server } = await app(() => {
      calls += 1;
      return new Promise((r) => (release = r));
    });
    const id = (await server.inject({ method: "POST", url: "/api/model-profiles", payload: COMPATIBLE })).json().profile
      .id as string;
    const a = server.inject({ method: "POST", url: `/api/model-profiles/${id}/test` });
    const c = server.inject({ method: "POST", url: `/api/model-profiles/${id}/test` });
    await new Promise((r) => setTimeout(r, 20));
    release({ ok: true });
    await Promise.all([a, c]);
    expect(calls).toBe(1);
    await server.close();
  });
});
