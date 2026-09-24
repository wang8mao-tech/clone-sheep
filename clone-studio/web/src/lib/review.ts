import { api } from "./api.js";
import type { AgentJobView } from "./agent.js";
import type { TemplateStatus } from "./archive.js";

/** ③ 验货（REQ-004、SCREEN-005）的数据层，形状对着 server/src/services/review.ts */

export const REWORK_NOTE_MAX = 2000;

export interface ReviewVersion {
  id: string;
  version: number;
  status: string;
  createdAt: string;
  build: { id: string; status: string; errorCode: string | null; endedAt: string | null } | null;
  /** 已出片的播放地址；没出片是 null */
  videoUrl: string | null;
}

export interface ReviewState {
  templateId: string;
  templateStatus: TemplateStatus;
  approvedReplicaId: string | null;
  /** 版本升序，最后一项是最新一版 */
  versions: ReviewVersion[];
  approvable: boolean;
  reworkable: boolean;
  nextRound: number;
}

export const reviewKeys = {
  state: (templateId: string) => ["review", templateId] as const,
};

export const reviewApi = {
  state: (templateId: string) => api.get<ReviewState>(`/api/templates/${templateId}/review`),
  approve: (templateId: string, productionId: string) =>
    api.post<ReviewState>(`/api/templates/${templateId}/approve`, { productionId }),
  rework: (templateId: string, note: string) =>
    api.post<{ job: AgentJobView; review: ReviewState }>(`/api/templates/${templateId}/rework`, { note }),
};

export interface Meta {
  duration: number;
  width: number;
  height: number;
}

/** 两片差异一行（SCREEN-005 SHOULD）：「时长差 +0.4s（复刻片更长）· 分辨率 1080×1920 / 720×1280」 */
export function describeDiff(reference: Meta | undefined, replica: Meta | undefined): string | null {
  if (!reference || !replica) return null;
  const delta = replica.duration - reference.duration;
  const time =
    Math.abs(delta) < 0.05
      ? "时长一致"
      : `时长差 ${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}s（复刻片${delta > 0 ? "更长" : "更短"}）`;
  const size = (m: Meta) => `${m.width}×${m.height}`;
  const res =
    reference.width === replica.width && reference.height === replica.height
      ? `分辨率一致 ${size(reference)}`
      : `分辨率 原片 ${size(reference)} / 复刻片 ${size(replica)}`;
  return `${time} · ${res}`;
}
