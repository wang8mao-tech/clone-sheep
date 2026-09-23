import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, vi } from "vitest";
import type { RunInput, RunOutcome } from "../agent/runner.js";

/**
 * Agent 任务接口测试的公共装置：临时数据目录 + 手动控制的假 run。
 * 验的是「消息落库 → SSE 通知 → 按 seq 拉增量」这条路，不开真会话。
 * 每个测试文件各自 import：vitest 的 beforeEach / afterEach 按文件注册，互不干扰。
 */
let dataRoot: string;
let app: FastifyInstance | undefined;
let closeDb: (() => void) | undefined;

interface Call {
  input: RunInput;
  emit(message: Record<string, unknown>): void;
  finish(outcome: RunOutcome): void;
}

export async function boot() {
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
  const dbMod = await import("../db/index.js");
  (await import("../db/migrate.js")).migrate();
  closeDb = dbMod.closeDb;

  const archive = await import("../services/archive.js");
  const client = archive.createClient("客户");
  const template = archive.createTemplate(client.id, "模板");
  // 工作目录要真存在：重跑会往里面写
  mkdirSync(template.workspace_path ?? "", { recursive: true });
  writeFileSync(path.join(template.workspace_path ?? "", "hypit.runtime.json"), "{}");

  const calls: Call[] = [];
  const run = (input: RunInput) =>
    new Promise<RunOutcome>((resolve) => {
      input.stopSignal?.addEventListener("abort", () => {
        const result = { type: "result", subtype: "error_during_execution", total_cost_usd: 0.1, errors: [] };
        input.onMessage(result as never);
        resolve({ aborted: true, result: result as never });
      });
      calls.push({ input, emit: (m) => input.onMessage(m as never), finish: resolve });
    });

  const service = await import("../agent/agent-service.js");
  service.resetAgentScheduler();
  const scheduler = service.agentScheduler({ overrides: { run } });
  const { agentJobRoutes } = await import("./agent-jobs.js");
  const Fastify = (await import("fastify")).default;
  app = Fastify({ logger: false });
  await app.register(agentJobRoutes);
  await app.ready();
  return { app, scheduler, calls, template, service, sse: (await import("../lib/sse.js")).sseHub };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-agent-api-"));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  closeDb?.();
  closeDb = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

export const assistant = (text: string) =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as Record<string, unknown>;
