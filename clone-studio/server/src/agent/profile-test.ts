import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { profileToken, type ProfileRow } from "./profiles.js";
import { agentEnv } from "./session.js";

/**
 * 「测试连接」（Spec REQ-010）：用档案发一次最小请求，回显成功 / 失败与上游错误原文；声明支持看图的附一张测试图。
 * - 订阅档案没有 key 可打：跑一次最小 SDK 会话（本机登录态），和真任务走同一条路
 * - 其余档案直接向 Messages API 发一条 16 token 以内的请求：兼容端点用 Bearer（同 ANTHROPIC_AUTH_TOKEN），
 *   官方 key 用 x-api-key（同 ANTHROPIC_API_KEY）。便宜、快，而且拿得到上游的 HTTP 状态与原文
 */

export interface ProbeResult {
  ok: boolean;
  /** 上游 HTTP 状态（订阅会话没有） */
  status?: number;
  /** 上游响应原文，界面原样展示 */
  detail?: string;
  /** 请求本身没发出去 / 会话起不来 */
  error?: string;
}

export const ANTHROPIC_API = "https://api.anthropic.com";
const TIMEOUT_MS = 60_000;
/** 上游原文最多回这么长，免得把一整页 HTML 塞进界面 */
const DETAIL_MAX = 4_000;

/** 16×16 的纯色 PNG（看图验证用）：现场编码，仓库里不放二进制 */
export function testImagePng(): Buffer {
  const size = 16;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0).fill(Buffer.from([220, 60, 40]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // 位深
  ihdr.writeUInt8(2, 9); // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function probeContent(vision: boolean) {
  const text = {
    type: "text" as const,
    text: vision ? "What color is this image? Reply in one word." : "Reply with OK.",
  };
  if (!vision) return [text];
  const image = {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png" as const, data: testImagePng().toString("base64") },
  };
  return [image, text];
}

/** Messages API 直连：兼容端点与官方 key 档案 */
export async function probeMessagesApi(row: ProfileRow, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const token = profileToken(row.id);
  if (!token) return { ok: false, error: "这个档案还没有 API key。" };
  const base = row.kind === "anthropic" ? ANTHROPIC_API : (row.base_url ?? "");
  const auth: Record<string, string> =
    row.kind === "anthropic" ? { "x-api-key": token } : { authorization: `Bearer ${token}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${base.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: { ...auth, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: row.model_id,
        max_tokens: 16,
        messages: [{ role: "user", content: probeContent(row.supports_vision === 1) }],
      }),
      signal: controller.signal,
    });
    const body = redact(await response.text(), token);
    if (!response.ok) return { ok: false, status: response.status, detail: body.slice(0, DETAIL_MAX) };
    // 2xx 还不够：base_url 指到一个对什么 POST 都回 200 的服务上也会是 2xx（10.1 审查 L2）
    if (!isMessage(body)) {
      return {
        ok: false,
        status: response.status,
        detail: `回的不是 Messages API 的消息：${body.slice(0, DETAIL_MAX)}`,
      };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), token);
    return { ok: false, error: controller.signal.aborted ? `${TIMEOUT_MS / 1000} 秒内没有响应` : message };
  } finally {
    clearTimeout(timer);
  }
}

/** 响应原文与报错里万一带上了 token（上游回显、请求头报错），换成打码值再回界面（REQ-008） */
function redact(text: string, token: string): string {
  return token ? text.split(token).join("•".repeat(12)) : text;
}

function isMessage(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { type?: unknown; content?: unknown };
    return parsed.type === "message" || Array.isArray(parsed.content);
  } catch {
    return false;
  }
}

/** 订阅档案：一次最小 SDK 会话（不给工具、一轮就停），跑在临时目录里，跑完删 */
export async function probeSubscription(model?: string | null): Promise<ProbeResult> {
  const cwd = mkdtempSync(path.join(tmpdir(), "cs-probe-sub-"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: probeContent(true) },
      parent_tool_use_id: null,
      session_id: "",
    };
  }
  try {
    const q = query({
      prompt: input(),
      options: {
        cwd,
        settingSources: [],
        tools: [],
        maxTurns: 1,
        persistSession: false,
        env: agentEnv(process.env),
        ...(model ? { model } : {}),
        abortController: controller,
      },
    });
    for await (const message of q) {
      if (message.type !== "result") continue;
      if (message.subtype === "success" && !message.is_error) return { ok: true };
      const detail = message.subtype === "success" ? message.result : message.errors.join("\n");
      return { ok: false, detail: detail.slice(0, DETAIL_MAX) };
    }
    return { ok: false, error: "会话没有返回结果" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: controller.signal.aborted ? `${TIMEOUT_MS / 1000} 秒内没有响应` : message };
  } finally {
    clearTimeout(timer);
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // Claude Code 进程还没退干净时 Windows 上删不掉：尽力而为，别让它盖掉测试结论（10.1 审查 L4）
    }
  }
}

export function probeProfile(row: ProfileRow): Promise<ProbeResult> {
  return row.kind === "subscription" ? probeSubscription(row.model_id) : probeMessagesApi(row);
}
