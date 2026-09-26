import { api, TIMEOUT_MS } from "./api.js";

/** 设置页「试出一张图」（REQ-011）：服务端 /api/codex/try 的形状 */
export interface CodexTry {
  id: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** 失败原文（Codex / hypit 的原话，已由服务端截断） */
  error: string | null;
  hasImage: boolean;
  /** 收尾停 Worker 没成功的原文：它可能还挂着、还在花额度 */
  cleanup: string | null;
}

export const codexKeys = { try: ["codex", "try"] as const };

export const codexApi = {
  latestTry: () => api.get<{ try: CodexTry | null }>("/api/codex/try").then((r) => r.try),
  // 回 202 之前服务端要跑 codex --version、停掉上一次的 Worker（runtime down 最长 60 秒）、同步包（11.3 审查 S2-M2）
  startTry: () => api.post<{ try: CodexTry }>("/api/codex/try", undefined, TIMEOUT_MS.codexTry).then((r) => r.try),
  imageUrl: (id: string) => `/api/codex/try/${encodeURIComponent(id)}/image`,
};
