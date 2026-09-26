import type { OwnerKind } from "./job-store.js";
import { SUBSCRIPTION_PROFILE_ID } from "./profile-presets.js";
import {
  defaultProfile,
  findProfile,
  priced,
  ProfileError,
  profileToken,
  requireProfile,
  type ProfileRow,
} from "./profiles.js";

/**
 * 档案怎么落到一次 Agent 会话上（Spec REQ-010「运行」，Task 10.2）：
 * - 建任务时挑档案、记快照（jobProfile）：档案 id、档案名、模型 id、花费口径
 * - 每次开跑（开始、继续、打回、等额度续跑）按快照与原档案算出这次会话的环境（runProfile）
 */

/** 花费口径：SDK 估算（订阅、官方 key）、按档案单价折算（兼容端点填了单价）、算不出（兼容端点没填单价） */
export type CostBasis = "sdk" | "price" | "none";

export function costBasisOf(row: Pick<ProfileRow, "kind" | "price_in" | "price_out">): CostBasis {
  if (row.kind !== "compatible") return "sdk";
  return priced(row) ? "price" : "none";
}

/** 任务建立时写进 agent_jobs 的档案快照 */
export interface JobProfile {
  profile_id: string;
  profile_name: string;
  model_id: string | null;
  cost_basis: CostBasis;
}

/** 档案能不能拿来开一次会话：非订阅档案要有 key */
function assertUsable(row: ProfileRow): void {
  if (row.kind !== "subscription" && !profileToken(row.id)) {
    throw new ProfileError("PROFILE_NO_TOKEN", `档案「${row.name}」还没有 API key，先在设置里补上。`, 409);
  }
}

/** 复刻要看参考视频的帧（REQ-010 MUST）：不支持看图的档案不能用来起复刻 */
export function assertVision(row: ProfileRow): void {
  if (row.supports_vision !== 1) {
    throw new ProfileError(
      "PROFILE_NO_VISION",
      `复刻要看参考视频的帧，「${row.name}」没有打开「支持看图」。换一个支持看图的档案。`,
      400,
    );
  }
}

/**
 * 给新任务挑档案并记快照。不给档案 id 用默认档案。复刻（模板的任务）要求看图。
 * `legacyModelId`：Phase 8 的过渡做法（④ 按模型 id 提交、老任务重跑），只配内置订阅
 */
export function jobProfile(input: {
  ownerKind: OwnerKind;
  profileId?: string | undefined;
  legacyModelId?: string | null;
}): JobProfile {
  // 过渡做法跑的是内置订阅：要验的是它，不是默认档案（10.2 审查 S1-M1）
  const legacy = !input.profileId && input.legacyModelId ? input.legacyModelId : null;
  const row = legacy
    ? requireProfile(SUBSCRIPTION_PROFILE_ID)
    : input.profileId
      ? requireProfile(input.profileId)
      : defaultProfile();
  assertUsable(row);
  if (input.ownerKind === "template") assertVision(row);
  return {
    profile_id: row.id,
    profile_name: row.name,
    model_id: legacy ?? row.model_id,
    cost_basis: legacy ? "sdk" : costBasisOf(row),
  };
}

/**
 * 档案 → 会话子进程的环境变量。订阅不注入任何变量；官方 key 只注入 ANTHROPIC_API_KEY；
 * 兼容端点注入 BASE_URL / AUTH_TOKEN / MODEL 与三档映射（opus、sonnet → 主模型，haiku → 快速模型），
 * 并关掉 Claude Code 的非必要外联（遥测之类不该绕过第三方端点直连 Anthropic）
 */
export function profileEnv(row: ProfileRow, token: string | undefined, model: string | null): Record<string, string> {
  if (row.kind === "subscription") return {};
  if (!token) throw new ProfileError("PROFILE_NO_TOKEN", `档案「${row.name}」还没有 API key。`, 409);
  const fast = row.fast_model_id ?? model;
  if (row.kind === "anthropic") {
    return {
      ANTHROPIC_API_KEY: token,
      ...(row.fast_model_id ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: row.fast_model_id } : {}),
    };
  }
  const main = model ?? "";
  return {
    ANTHROPIC_BASE_URL: row.base_url ?? "",
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: fast ?? main,
    CLAUDE_CODE_SUBAGENT_MODEL: fast ?? main,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** 一次会话按档案跑要用的全部东西 */
export interface RunProfile {
  env: Record<string, string>;
  /** 订阅（内置或指定模型）：走本机登录态，不能把订阅令牌去掉 */
  subscription: boolean;
  webSearch: boolean;
  model: string | null;
  basis: CostBasis;
  /** 按单价折算时用（美元 / 百万 token） */
  pricing: { in: number; out: number } | null;
  /** 这次注入的凭据：消息落库前要打码的字符串 */
  secrets: string[];
}

/**
 * 按任务的快照与原档案算出这次会话的配置。继续、打回、等额度续跑都走这里——
 * 原档案删了或 key 没了就抛（REQ-010：换模型只能重跑）。老任务（没记档案）按内置订阅 + 当时的模型 id 跑
 */
export function runProfile(job: {
  profile_id: string | null;
  profile_name: string | null;
  model_id: string | null;
}): RunProfile {
  const row = findProfile(job.profile_id ?? SUBSCRIPTION_PROFILE_ID);
  if (!row) {
    throw new ProfileError(
      "PROFILE_GONE",
      `原档案「${job.profile_name ?? job.profile_id}」已经删了，只能重跑（可以重选档案）。`,
      409,
    );
  }
  const token = row.kind === "subscription" ? undefined : profileToken(row.id);
  if (row.kind !== "subscription" && !token) {
    throw new ProfileError("PROFILE_GONE", `原档案「${row.name}」的 API key 没了，补上 key 再继续，或者重跑。`, 409);
  }
  const basis = job.profile_id ? costBasisOf(row) : "sdk";
  return {
    env: profileEnv(row, token, job.model_id),
    subscription: row.kind === "subscription",
    webSearch: row.supports_web_search === 1,
    model: job.model_id,
    basis,
    pricing: basis === "price" ? { in: row.price_in ?? 0, out: row.price_out ?? 0 } : null,
    secrets: token ? [token] : [],
  };
}

/**
 * 消息里出现了注入的凭据（Agent 想办法打印了环境、上游报错回显了 key）：落库、推给界面前换成打码（REQ-008）。
 * 逐个字符串值替换原文，以及它被 JSON 转义一层、两层后的样子（工具结果里常是「字符串里装着 JSON」）。
 * 一处都没碰到就原样返回同一个对象
 */
export function redactSecrets<T>(message: T, secrets: readonly string[]): T {
  const forms = secrets
    .filter((s) => s.length >= 8)
    .flatMap((s) => {
      const once = JSON.stringify(s).slice(1, -1);
      return [s, once, JSON.stringify(once).slice(1, -1), encodeURIComponent(s)];
    })
    .sort((a, b) => b.length - a.length);
  if (forms.length === 0) return message;
  let hit = false;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const form of forms) if (out.includes(form)) out = out.split(form).join("••••••••••••");
      if (out !== value) hit = true;
      return out;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  const out = walk(message);
  return hit ? (out as T) : message;
}

/**
 * 重跑用哪个档案（REQ-010：重跑可重选）：给了就用给的；没给用原档案（还在的话），原档案没了用默认档案。
 * 原任务是「内置订阅 + 指定模型 id」的过渡做法（Phase 8），沿用那个模型
 */
export function rerunChoice(
  job: { profile_id: string | null; model_id: string | null },
  profileId?: string,
): { profileId?: string; modelId?: string } {
  if (profileId) return { profileId };
  // 没记档案的老任务就是在内置订阅上跑的：原档案 = 订阅（与 runProfile 一致，10.2 审查 S1-L1）
  const original = findProfile(job.profile_id ?? SUBSCRIPTION_PROFILE_ID);
  const legacyModel = job.model_id && (!job.profile_id || (original?.builtin === 1 && original.model_id === null));
  if (legacyModel) return { modelId: job.model_id as string };
  return original ? { profileId: original.id } : {};
}

/**
 * 花费不按 SDK 估算的档案（兼容端点）：SDK 的 maxBudgetUsd 用它自己的价目表估第三方模型，会乱熔断，
 * 给一个碰不到的上限，$ 熔断改由按单价折算的 PriceMeter 判（REQ-010）
 */
export const SDK_BUDGET_OFF = 1_000_000;
