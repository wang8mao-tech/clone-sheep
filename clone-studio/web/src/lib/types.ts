export type { CheckResult, CheckStatus } from "../components/HealthRow.js";

export interface HealthSummary {
  checks: import("../components/HealthRow.js").CheckResult[];
  passed: number;
  total: number;
  blockingFailures: import("../components/HealthRow.js").CheckResult[];
}

export interface Settings {
  perItemLimitUsd: number;
  batchLimitUsd: number;
  agentTimeoutMinutes: number;
  agentBudgetUsd: number;
  agentConcurrency: number;
  renderConcurrency: number;
  renderWorkers: number;
  referenceMaxSeconds: number;
  batchMaxItems: number;
  codexProviderEnabled: boolean;
  updatedAt: string;
  paths: { dataRoot: string; hypitRoot: string; secrets: string };
  /** 打码值，null 表示未配置。明文永不到前端。 */
  credentials: {
    tokendance: string | null;
    hypihub: string | null;
    tokendanceVerifiedAt: string | null;
    hypihubVerifiedAt: string | null;
  };
}

export interface VerifyResult {
  ok: boolean;
  status?: number;
  /** 服务端响应原文 */
  detail?: string;
  error?: string;
}
