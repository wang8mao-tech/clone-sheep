import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootProfiles, COMPATIBLE, useProfileSandbox } from "./profiles-test-kit.js";

/** 测试连接（REQ-010、AC-028）：本地假 Anthropic 兼容端点记下收到的请求 */

useProfileSandbox();

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  body: { model: string; max_tokens: number; messages: Array<{ content: Array<{ type: string }> }> };
}

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function fakeEndpoint(status: number, reply: string) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) as Seen["body"] });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(reply);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic` };
}

describe("兼容端点：直接打 Messages API", () => {
  it("路径接在 base_url 后、Bearer 带 token、用主模型；声明看图的附一张 PNG", async () => {
    const b = await bootProfiles();
    const up = await fakeEndpoint(200, JSON.stringify({ content: [{ type: "text", text: "Red" }] }));
    const row = b.profiles.createProfile({ ...COMPATIBLE, baseUrl: up.base });
    const { probeMessagesApi } = await import("./profile-test.js");
    expect(await probeMessagesApi(row)).toEqual({ ok: true, status: 200 });
    const [req] = up.seen;
    expect(req!.url).toBe("/anthropic/v1/messages");
    expect(req!.headers.authorization).toBe(`Bearer ${COMPATIBLE.token}`);
    expect(req!.headers["x-api-key"]).toBeUndefined();
    expect(req!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req!.body.model).toBe("deepseek-flash");
    expect(req!.body.max_tokens).toBeLessThanOrEqual(16);
    expect(req!.body.messages[0]!.content.map((c) => c.type)).toEqual(["image", "text"]);
  });

  it("上游回 2xx 但不是一条消息（代理首页之类）：不算通过（10.1 审查 L2）", async () => {
    const b = await bootProfiles();
    const up = await fakeEndpoint(200, "<html>LiteLLM</html>");
    const row = b.profiles.createProfile({ ...COMPATIBLE, baseUrl: up.base });
    const { probeMessagesApi } = await import("./profile-test.js");
    const result = await probeMessagesApi(row);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("<html>LiteLLM</html>");
  });

  it("上游原文或报错里带着 token：换成打码再回（REQ-008）", async () => {
    const b = await bootProfiles();
    const up = await fakeEndpoint(401, `{"error":"bad key ${COMPATIBLE.token}"}`);
    const row = b.profiles.createProfile({ ...COMPATIBLE, baseUrl: up.base });
    const { probeMessagesApi } = await import("./profile-test.js");
    const failed = await probeMessagesApi(row);
    expect(JSON.stringify(failed)).not.toContain(COMPATIBLE.token);
    expect(failed.detail).toContain("bad key ••••");
    const thrown = await probeMessagesApi(row, async () => {
      throw new Error(`Headers.append: "Bearer ${COMPATIBLE.token}" is an invalid header value.`);
    });
    expect(JSON.stringify(thrown)).not.toContain(COMPATIBLE.token);
    expect(thrown.ok).toBe(false);
  });

  it("token 里有引号、反斜杠：上游在 JSON 里回显的转义形式也打码（10.1 第二轮审查 N2）", async () => {
    const b = await bootProfiles();
    const token = 'sk-abc"def\\1234567';
    const up = await fakeEndpoint(401, JSON.stringify({ error: `bad key ${token}` }));
    const row = b.profiles.createProfile({ ...COMPATIBLE, baseUrl: up.base, token });
    const { probeMessagesApi } = await import("./profile-test.js");
    const failed = await probeMessagesApi(row);
    expect(failed.detail).not.toContain("sk-abc");
  });

  it("不支持看图的：只发文字", async () => {
    const b = await bootProfiles();
    const up = await fakeEndpoint(200, "{}");
    const row = b.profiles.createProfile({ ...COMPATIBLE, baseUrl: up.base, supportsVision: false });
    const { probeMessagesApi } = await import("./profile-test.js");
    await probeMessagesApi(row);
    expect(up.seen[0]!.body.messages[0]!.content.map((c) => c.type)).toEqual(["text"]);
  });

  it("填错 key：回上游状态与响应原文（AC-028）", async () => {
    const b = await bootProfiles();
    const body = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
    const up = await fakeEndpoint(401, body);
    const row = b.profiles.createProfile({ ...COMPATIBLE, baseUrl: up.base });
    const { probeMessagesApi } = await import("./profile-test.js");
    expect(await probeMessagesApi(row)).toEqual({ ok: false, status: 401, detail: body });
  });

  it("连不上：回错误，不是成功", async () => {
    const b = await bootProfiles();
    const row = b.profiles.createProfile({ ...COMPATIBLE, baseUrl: "http://127.0.0.1:1" });
    const { probeMessagesApi } = await import("./profile-test.js");
    const result = await probeMessagesApi(row);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("官方 key 档案：打 api.anthropic.com，用 x-api-key 不用 Bearer", async () => {
    const b = await bootProfiles();
    const row = b.profiles.createProfile({ ...COMPATIBLE, name: "官方", kind: "anthropic" });
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url instanceof Request ? url.url : url.toString(),
        headers: init?.headers as Record<string, string>,
      });
      return new Response("{}", { status: 200 });
    });
    const { probeMessagesApi } = await import("./profile-test.js");
    await probeMessagesApi(row, fetchStub);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe(COMPATIBLE.token);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
});

describe("测试图", () => {
  it("是合法的 16×16 RGB PNG", async () => {
    const { testImagePng } = await import("./profile-test.js");
    const png = testImagePng();
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(16);
    expect(png.readUInt32BE(20)).toBe(16);
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString("ascii")).toBe("IDAT");
    expect(inflateSync(png.subarray(41, 41 + idatLength))).toHaveLength(16 * (1 + 16 * 3));
  });
});

describe("订阅档案：最小 SDK 会话", () => {
  it("成功 / 失败都照 result 回；不给工具、一轮就停、跑完删临时目录；环境里的 ANTHROPIC_* 带不进去", async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_API_KEY = "sk-from-shell-should-not-leak";
    process.env.ANTHROPIC_BASE_URL = "https://elsewhere.example.com";
    const seen: Array<Record<string, unknown>> = [];
    let outcome: Record<string, unknown> = { type: "result", subtype: "success", is_error: false, result: "Red" };
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: ({ options }: { options: Record<string, unknown> }) => {
        seen.push(options);
        return (async function* () {
          yield outcome;
        })();
      },
    }));
    const { existsSync } = await import("node:fs");
    const { probeSubscription } = await import("./profile-test.js");
    expect(await probeSubscription()).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ tools: [], maxTurns: 1, settingSources: [], persistSession: false });
    expect(existsSync(seen[0]!.cwd as string)).toBe(false);
    const env = seen[0]!.env as Record<string, string>;
    expect(Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_"))).toEqual([]);

    outcome = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Not logged in"] };
    expect(await probeSubscription()).toEqual({ ok: false, detail: "Not logged in" });
    // 「本机订阅 · 指定模型」：模型交给 SDK
    await probeSubscription("claude-sonnet-5");
    expect(seen[2]!.model).toBe("claude-sonnet-5");
    expect(seen[0]!.model).toBeUndefined();
    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
    for (const [name, value] of [
      ["ANTHROPIC_API_KEY", saved.key],
      ["ANTHROPIC_BASE_URL", saved.base],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
});
