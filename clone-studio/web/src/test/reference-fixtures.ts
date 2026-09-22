/**
 * ① 参考 页用例共用的桩与小工具。形状与后端逐字段对齐：listSteps 永远四行、
 * 模板详情带 evidenceStatus、下载完成即 hasSource——桩和真实后端不一致曾把
 * 步骤条的 HIGH 缺陷盖成绿（Task 4.4 审查）。
 */
import { screen, within } from "@testing-library/react";
import { healthStubs, stubFetch, type RouteStub } from "./harness.js";
import type { EvidenceState, EvidenceStepRecord } from "../lib/evidence.js";
import type { TemplateStatus } from "../lib/archive.js";

export const CLIENT_ID = "8ba62e60-9ee5-43d5-b021-a1f8f5bf3499";
export const TPL_ID = "a6562a0a-0bab-4484-8aa2-9e2d7127e3a2";
export const BASE = `/clients/${CLIENT_ID}/templates/${TPL_ID}`;
export const EVIDENCE = `/api/templates/${TPL_ID}/evidence`;

export const client = { id: CLIENT_ID, name: "老王工作室", createdAt: "2026-09-20T04:10:35.093Z" };

export function detail(status: TemplateStatus, over: Record<string, unknown> = {}) {
  return {
    id: TPL_ID,
    clientId: CLIENT_ID,
    name: "足球榜单",
    status,
    language: null,
    note: null,
    sourceKind: null,
    sourceUrl: null,
    hasSource: false,
    workspacePath: "C:/data/x",
    createdAt: "2026-09-20T04:10:35.093Z",
    updatedAt: "2026-09-20T04:10:35.093Z",
    client,
    stats: { outputs: 0, totalCostUsd: 0, costIsEstimate: false, lastActivityAt: "2026-09-20T04:10:35.093Z" },
    ...over,
  };
}

export type Row = [EvidenceStepRecord["step"], EvidenceStepRecord["status"], Partial<EvidenceStepRecord>?];

export function evidence(
  status: EvidenceState["status"],
  rows: Row[],
  extra: Partial<EvidenceState> = {},
): EvidenceState {
  return {
    templateId: TPL_ID,
    status,
    steps: rows.map(([step, s, more]) => ({ step, status: s, ...more })),
    ...extra,
  };
}

export const PENDING: Row[] = [
  ["fetch", "pending"],
  ["probe", "pending"],
  ["transcribe", "pending"],
  ["tiles", "pending"],
];
/** 后端 listSteps 永远返回四行：没提交过就是四行 pending */
export const IDLE = evidence("idle", PENDING);

export function stub(
  templateStatus: TemplateStatus,
  state: EvidenceState,
  extra: Record<string, RouteStub | ((init?: RequestInit) => RouteStub)> = {},
  tplOver: Record<string, unknown> = {},
) {
  stubFetch({
    ...healthStubs,
    "/api/clients": {
      body: { clients: [{ ...client, templates: [{ id: TPL_ID, name: "足球榜单", status: templateStatus }] }] },
    },
    // 与真实后端一致：evidenceStatus 跟着证据快照走，源视频在下载完成那一刻就有了
    [`/api/templates/${TPL_ID}`]: {
      body: detail(templateStatus, {
        evidenceStatus: state.status,
        hasSource: state.steps.some((st) => st.step === "fetch" && st.status === "done"),
        ...tplOver,
      }),
    },
    [EVIDENCE]: { body: state },
    "/api/settings": { body: { referenceMaxSeconds: 180 } },
    ...extra,
  });
}

export function bodyOf(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("请求体不是 JSON 字符串");
  return JSON.parse(init.body) as Record<string, unknown>;
}

/** 步骤条里某一步的按钮（状态靠 sr-only 文字读出） */
export function stepButton(label: string): HTMLElement {
  return within(screen.getByRole("navigation", { name: "流水线步骤" })).getByRole("button", {
    name: new RegExp(`^${label}`),
  });
}

export function row(label: RegExp): HTMLElement {
  return within(screen.getByRole("list", { name: "证据准备清单" })).getByRole("listitem", { name: label });
}
