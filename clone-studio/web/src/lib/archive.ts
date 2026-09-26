import { api, TIMEOUT_MS } from "./api.js";

/**
 * 归档域（客户 / 模板）的类型与请求。
 *
 * 类型逐字段对着 server/src/services/archive.ts 的 presentClient / presentTemplate /
 * templateStats 与 deletion.ts 的 DeletionImpact 写，后端改了这里必须跟着改。
 */

export type TemplateStatus = "importing" | "cloning" | "awaiting_review" | "approved" | "failed";

/** 侧栏树的节点，来自 GET /api/clients */
export interface SidebarTemplate {
  id: string;
  name: string;
  status: TemplateStatus;
}

export interface SidebarClient {
  id: string;
  name: string;
  createdAt: string;
  templates: SidebarTemplate[];
}

export interface Client {
  id: string;
  name: string;
  createdAt: string;
}

export interface Template {
  id: string;
  clientId: string;
  name: string;
  status: TemplateStatus;
  language: string | null;
  note: string | null;
  sourceKind: string | null;
  sourceUrl: string | null;
  /** 参考视频导入了没有。缩略帧要等 Phase 4 抽帧才有。 */
  hasSource: boolean;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateStats {
  outputs: number;
  totalCostUsd: number;
  /** 合计里含估算值，界面要带「估」徽标 */
  costIsEstimate: boolean;
  /** 有 Agent 任务的档案没填单价，那部分算不出、不在合计里：界面标「含未知」（Task 11.4） */
  costHasUnknown: boolean;
  lastActivityAt: string;
}

export interface ClientDetail {
  client: Client;
  templates: (Template & { stats: TemplateStats })[];
}

export interface TemplateDetail extends Template {
  client: Client;
  stats: TemplateStats;
  /** 证据准备的整体状态，步骤条靠它判断 failed 落在哪一步 */
  evidenceStatus: "idle" | "running" | "done" | "failed";
}

/** 删除弹窗（CMP-012）要列的级联影响 */
export interface DeletionImpact {
  kind: "client" | "template";
  id: string;
  name: string;
  templates: number;
  productions: number;
  runningTasks: number;
  directories: string[];
}

export const archiveKeys = {
  clients: ["clients"] as const,
  client: (id: string) => ["clients", id] as const,
  template: (id: string) => ["templates", id] as const,
};

export const archiveApi = {
  listClients: () => api.get<{ clients: SidebarClient[] }>("/api/clients"),
  client: (id: string) => api.get<ClientDetail>(`/api/clients/${id}`),
  createClient: (name: string) => api.post<Client>("/api/clients", { name }),
  renameClient: (id: string, name: string) => api.patch<Client>(`/api/clients/${id}`, { name }),
  clientImpact: (id: string) => api.get<DeletionImpact>(`/api/clients/${id}/deletion-impact`),
  deleteClient: (id: string) => api.delete<DeletionImpact>(`/api/clients/${id}`, TIMEOUT_MS.deletion),

  createTemplate: (clientId: string, name: string) =>
    api.post<Template>(`/api/clients/${clientId}/templates`, { name }, TIMEOUT_MS.createTemplate),
  template: (id: string) => api.get<TemplateDetail>(`/api/templates/${id}`),
  renameTemplate: (id: string, name: string) => api.patch<Template>(`/api/templates/${id}`, { name }),
  templateImpact: (id: string) => api.get<DeletionImpact>(`/api/templates/${id}/deletion-impact`),
  deleteTemplate: (id: string) => api.delete<DeletionImpact>(`/api/templates/${id}`, TIMEOUT_MS.deletion),
};

/**
 * 删除弹窗的影响清单文案。
 * 0 的条目不列——列一堆「0 个」只会淹没真正要看的那条。
 */
export function impactLines(impact: DeletionImpact): string[] {
  const lines: string[] = [];
  if (impact.kind === "client") lines.push(`连带删除 ${impact.templates} 个模板`);
  if (impact.productions > 0) lines.push(`连带删除 ${impact.productions} 条成片与变体`);
  if (impact.runningTasks > 0) lines.push(`将中止 ${impact.runningTasks} 个运行中的任务`);
  for (const dir of impact.directories) lines.push(`磁盘目录 ${dir} 将被删除，不可恢复`);
  if (lines.length === 0) lines.push("没有连带内容，只删这一条记录");
  return lines;
}
