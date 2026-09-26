import { api, ApiError } from "./api.js";

/**
 * 证据准备（REQ-002）的前端数据层。形状与 server/src/services/evidence*.ts 逐字段对齐。
 *
 * 后端每次步骤状态变化推一条 `template:<id>` / `evidence` 事件，前端只拿它当
 * 「快照失效」的提示去重拉 GET /evidence，不在前端累积状态——刷新页面走的
 * 是同一个 GET，所以刷新后清单不丢。
 */

export const EVIDENCE_STEPS = ["fetch", "probe", "transcribe", "tiles"] as const;
export type EvidenceStep = (typeof EVIDENCE_STEPS)[number];
export type EvidenceStepStatus = "pending" | "running" | "done" | "failed" | "timeout";
export type PipelineStatus = "idle" | "running" | "done" | "failed";
export type SourceMode = "url" | "file";

export interface ProbeFacts {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
}

export interface EvidenceStepRecord {
  step: EvidenceStep;
  status: EvidenceStepStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  /** hypit 的原始输出，界面原样展示不改写（REQ-002 MUST） */
  errorRaw?: string;
  detail?: unknown;
}

export interface EvidenceState {
  templateId: string;
  status: PipelineStatus;
  steps: EvidenceStepRecord[];
  sourcePath?: string;
  probe?: ProbeFacts;
}

export interface UploadResult {
  uploadPath: string;
  filename: string;
  size: number;
}

export interface StartEvidenceBody {
  language: string;
  note?: string;
  url?: string;
  uploadPath?: string;
  /** Agent 模型档案（REQ-010、CMP-010）；复刻要支持看图 */
  profileId?: string;
}

/** 设计稿「① 参考」清单的文案。转写注明走本地 WhisperX（REQ-002 MUST） */
export const EVIDENCE_LABELS: Record<EvidenceStep, string> = {
  fetch: "下载",
  probe: "探测",
  transcribe: "转写（本地 WhisperX）",
  tiles: "抽帧拼图",
};

/** 与后端 routes/reference.ts 的 LANGUAGES 同一份，顺序按常用度 */
export const LANGUAGE_OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "ru", label: "Русский" },
  { value: "pt", label: "Português" },
  { value: "it", label: "Italiano" },
  { value: "ar", label: "العربية" },
  { value: "hi", label: "हिन्दी" },
] as const;

/** REQ-002 输入表 */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = [".mp4", ".mov", ".webm"] as const;
export const NOTE_MAX = 1000;

/**
 * 不挂在 ["templates"] 前缀下：useInvalidateArchive 按那个前缀整支失效，
 * 挂进去的话每条归档事件（侧栏改个名）都会连带重拉证据快照。
 */
export const evidenceKeys = {
  state: (templateId: string) => ["evidence", templateId] as const,
};

export const evidenceApi = {
  state: (templateId: string) => api.get<EvidenceState>(`/api/templates/${templateId}/evidence`),
  start: (templateId: string, body: StartEvidenceBody) =>
    api.post<EvidenceState>(`/api/templates/${templateId}/evidence`, body),
  retry: (templateId: string, step: EvidenceStep) =>
    api.post<EvidenceState>(`/api/templates/${templateId}/evidence/${step}/retry`),
  upload,
};

/**
 * 上传走 multipart，不能用 api.post：那条会把 body JSON.stringify 并套 5 秒超时。
 * 500 MB 在本机回环上也要几十秒，这里不设超时——上传是用户主动发起、看得见
 * 转圈的动作，后端掐流由 @fastify/multipart 的 fileSize 上限负责。
 */
async function upload(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  let res: Response;
  try {
    res = await fetch("/api/uploads", { method: "POST", body: form });
  } catch {
    // 后端没起、连接被掐：fetch 抛的是英文 TypeError「Failed to fetch」，界面要中文
    throw new ApiError("上传失败：连不上后端，确认后端在运行后重试。", 0, undefined, "NETWORK");
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const body = parsed as { error?: { message?: string; code?: string } } | undefined;
    throw new ApiError(
      body?.error?.message ?? `上传失败（HTTP ${res.status}）`,
      res.status,
      text || undefined,
      body?.error?.code,
    );
  }
  return parsed as UploadResult;
}

/** 选文件时就地校验，免得传完 500 MB 才被后端拒 */
export function checkFile(file: File): string | undefined {
  const lower = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "只支持 mp4 / mov / webm。";
  if (file.size > MAX_UPLOAD_BYTES) return `文件 ${(file.size / 1024 / 1024).toFixed(0)} MB，超过 500 MB 上限。`;
  if (file.size === 0) return "这是一个空文件。";
  return undefined;
}

/** 输入框里的链接校验，与后端 zod 规则一致：http/https */
export function checkUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "先粘贴一个视频链接。";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "这不是一个有效的链接。";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "只支持 http/https 链接。";
  return undefined;
}

/** 耗时显示成 m:ss（设计稿「0:14」）。超过一小时的步骤不存在——单步 10 分钟就超时 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 探测结果一行：「0:38 · 1080×1920 · 30fps」 */
export function describeProbe(facts: ProbeFacts): string {
  const parts = [formatElapsed(facts.duration * 1000)];
  if (facts.width && facts.height) parts.push(`${facts.width}×${facts.height}`);
  if (facts.frameRate) parts.push(`${Math.round(facts.frameRate)}fps`);
  return parts.join(" · ");
}
