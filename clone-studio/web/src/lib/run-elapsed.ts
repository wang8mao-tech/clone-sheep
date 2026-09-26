import { formatElapsed } from "./evidence.js";
import { isActive, type AgentJobView } from "./agent.js";

type Timing = Pick<AgentJobView, "status" | "runElapsedMs" | "runStartedAt">;

/**
 * 本次运行的用时（DEV-PLAN Phase 5，照抄那条公式，所有状态都成立）：
 * `runElapsedMs + (status === "running" ? now - runStartedAt : 0)`。
 * 等额度、排队时自然冻住。服务端时间戳配浏览器 now，客户端时钟慢时 running 那段会算出
 * 负数，所以外面夹一层 0。
 */
export function runElapsedMs(job: Timing, now: number): number {
  const started = job.runStartedAt ? Date.parse(job.runStartedAt) : Number.NaN;
  const live = job.status === "running" && Number.isFinite(started) ? now - started : 0;
  return Math.max(0, job.runElapsedMs + live);
}

/**
 * 顶栏与结束卡上的用时文字。后端崩溃留下的「运行中」被重启标成中断时，那一段的时长无从得知、
 * 记成了 0：终态上 runElapsedMs 为 0 而 runStartedAt 非空，显示「—」比「0:00」诚实。
 */
export function formatRunElapsed(job: Timing, now: number): string {
  if (!isActive(job.status) && job.runElapsedMs === 0 && job.runStartedAt !== null) return "—";
  return formatDuration(runElapsedMs(job, now));
}

/** m:ss，超过一小时 h:mm:ss（Agent 墙钟上限 45 分钟，但设置页能调大） */
export function formatDuration(ms: number): string {
  // 时间戳坏了算出 NaN 时给 0:00，别把「NaN:NaN」显示出来
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (total < 3600) return formatElapsed(total * 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
