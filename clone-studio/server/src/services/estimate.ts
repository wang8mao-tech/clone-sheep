/**
 * 估价（REQ-006「估价来源」）：hypit 不出数，Clone Studio 用自维护费率表 × `plan --json` 的请求自己算。
 * 纯函数，输入是 plan 的原样 JSON 与费率表，输出估价明细；是否放行交给 gate.ts。
 *
 * - 每个请求：`providers[]` 与 `needs[]` 按 `request` 对上（Phase 6 实跑 plan 确认）
 * - `pricing.kind === "local"` 的默认 $0；费率表里写了这个能力就按写的算（人要把本机渲染也记成本时用）
 * - `pricing.kind === "page"`：费率表里没有这个能力 → 这一行拿不到，整张估价拿不到（按超限）
 * - 按秒计价要知道时长：needs 的 startFrame / endFrameExclusive / frameRate，或 duration；缺了也算拿不到
 * - 未解析 / 不支持 / 多个 Endpoint 的请求、preflight 没过：不估价，直接判「出片失败」并写明缺哪种能力
 */

export type RateUnit = "request" | "second";

export interface Rate {
  capability: string;
  /** 只对某个 Endpoint 生效；空表示这个能力走哪个 Endpoint 都用它 */
  endpoint: string | null;
  unit: RateUnit;
  usd: number;
}

export interface EstimateLine {
  capability: string;
  endpoint: string | null;
  /** 这一组有几个请求 */
  count: number;
  unit: RateUnit | null;
  unitUsd: number | null;
  /** 这一组合计；拿不到是 null */
  usd: number | null;
  local: boolean;
  /** Provider 公布的价格页，供人核对费率表是否过期 */
  pricingUrl: string | null;
  /** 拿不到时的原因 */
  missing: string | null;
}

export type Estimate =
  | { kind: "ok"; totalUsd: number | null; lines: EstimateLine[]; providerRequestCount: number }
  | { kind: "blocked"; reason: string; lines: EstimateLine[] };

interface PlanProvider {
  request?: unknown;
  capability?: unknown;
  status?: unknown;
  endpoint?: unknown;
  pricing?: { kind?: unknown; url?: unknown };
}

interface PlanNeed {
  request?: unknown;
  issue?: unknown;
  summary?: { fields?: Record<string, unknown> };
}

interface PlanJson {
  ok?: unknown;
  requestCount?: unknown;
  requestIssueCount?: unknown;
  providerRequestCount?: unknown;
  unresolvedRequestCount?: unknown;
  unsupportedRequestCount?: unknown;
  providers?: unknown;
  needs?: unknown;
  preflight?: { ok?: unknown; diagnostics?: unknown };
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 一个请求的时长（秒）。frameRate 是 "30/1" 这种分数 */
export function secondsOf(fields: Record<string, unknown> | undefined): number | null {
  if (!fields) return null;
  // Seedance 2.5 的 duration 可以是 -1（自动，真实时长最长 30 秒）：不是正数就当拿不到，不能算出负价压低总价
  const duration = num(fields.duration) ?? num(fields.durationSeconds);
  if (duration !== null) return duration > 0 ? duration : null;
  const start = num(fields.startFrame);
  const end = num(fields.endFrameExclusive);
  const rate = typeof fields.frameRate === "string" ? fields.frameRate : null;
  if (start === null || end === null || !rate) return null;
  const [n, d = "1"] = rate.split("/");
  const fps = Number(n) / Number(d);
  const seconds = Number.isFinite(fps) && fps > 0 ? (end - start) / fps : null;
  return seconds !== null && seconds > 0 ? seconds : null;
}

function findRate(rates: readonly Rate[], capability: string, endpoint: string | null): Rate | undefined {
  return (
    rates.find((r) => r.capability === capability && r.endpoint !== null && r.endpoint === endpoint) ??
    rates.find((r) => r.capability === capability && r.endpoint === null)
  );
}

export function estimateFromPlan(planJson: unknown, rates: readonly Rate[]): Estimate {
  const plan = (planJson ?? {}) as PlanJson;
  const providers = (Array.isArray(plan.providers) ? plan.providers : []) as PlanProvider[];
  const needs = (Array.isArray(plan.needs) ? plan.needs : []) as PlanNeed[];
  const fieldsByRequest = new Map(needs.map((n) => [str(n.request), n.summary?.fields]));

  const unresolved = providers.filter((p) => p.status !== "resolved");
  if (
    unresolved.length > 0 ||
    (num(plan.unresolvedRequestCount) ?? 0) > 0 ||
    (num(plan.unsupportedRequestCount) ?? 0) > 0
  ) {
    const caps = [...new Set(unresolved.map((p) => str(p.capability) ?? "未知能力"))];
    return { kind: "blocked", reason: `有请求没有可用的 Provider：${caps.join("、") || "未知能力"}`, lines: [] };
  }
  if (plan.preflight && plan.preflight.ok === false) {
    const diags = Array.isArray(plan.preflight.diagnostics) ? plan.preflight.diagnostics : [];
    return { kind: "blocked", reason: `preflight 没有通过：${JSON.stringify(diags)}`, lines: [] };
  }
  // 请求本身有问题（hypit 把 requestIssueCount > 0 也算 ok:false、退出码 1）：不出片，把 needs 里的 issue 原文带出
  if ((num(plan.requestIssueCount) ?? 0) > 0 || plan.ok === false) {
    const issues = needs.map((n) => str(n.issue)).filter((i): i is string => i !== null);
    return {
      kind: "blocked",
      reason: `plan 报请求有问题：${issues.join("；") || "hypit plan 未通过（ok: false）"}`,
      lines: [],
    };
  }
  // 没有 Runtime Host 时 hypit 不给 providers：有请求却没法定价，按拿不到处理，不能算成 $0 自动放行
  if (!Array.isArray(plan.providers) && (num(plan.requestCount) ?? 0) > 0) {
    return { kind: "ok", totalUsd: null, lines: [], providerRequestCount: num(plan.providerRequestCount) ?? 0 };
  }

  const groups = new Map<string, EstimateLine>();
  for (const p of providers) {
    const capability = str(p.capability) ?? "未知能力";
    const endpoint = str(p.endpoint);
    const local = p.pricing?.kind === "local";
    const pricingUrl = p.pricing?.kind === "page" ? str(p.pricing.url) : null;
    const rate = findRate(rates, capability, endpoint);
    const key = `${endpoint ?? ""} ${capability}`;
    const line = groups.get(key) ?? {
      capability,
      endpoint,
      count: 0,
      unit: rate?.unit ?? null,
      unitUsd: rate?.usd ?? (local ? 0 : null),
      usd: 0,
      local,
      pricingUrl,
      missing: null,
    };
    line.count += 1;
    if (line.usd !== null) {
      let amount: number | null;
      if (!rate) amount = local ? 0 : null;
      else if (rate.unit === "request") amount = rate.usd;
      else {
        const seconds = secondsOf(fieldsByRequest.get(str(p.request)));
        amount = seconds === null ? null : seconds * rate.usd;
        if (seconds === null) line.missing = "按秒计价，但 plan 没给出时长";
      }
      if (amount === null) {
        line.usd = null;
        line.missing ??= "费率表里没有这个能力的单价";
      } else line.usd += amount;
    }
    groups.set(key, line);
  }
  const lines = [...groups.values()];
  const total = lines.some((l) => l.usd === null) ? null : lines.reduce((s, l) => s + (l.usd ?? 0), 0);
  return { kind: "ok", totalUsd: total, lines, providerRequestCount: num(plan.providerRequestCount) ?? 0 };
}
