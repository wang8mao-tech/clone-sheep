import { api, ApiError } from "./api.js";
import type { VariantView } from "./variants.js";

/** 素材审核（REQ-005、SCREEN-007）的数据层，形状对着 server/src/services/variant-review.ts */

/** REQ-005 输入表：替换图 jpg / png / webp，≤20 MB */
export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"] as const;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface AssetView {
  id: string;
  label: string | null;
  file: string | null;
  sourceUrl: string | null;
  sourceHost: string | null;
  replaced: boolean;
  gap: boolean;
  imageUrl: string | null;
}

export interface VariantReviewState {
  /** 变体属于哪个模板：`?variant=` 是别的模板的，按不存在处理 */
  templateId: string;
  variant: VariantView;
  assets: AssetView[];
  script: string | null;
  scriptTruncated: boolean;
  perItemLimitUsd: number;
  batch: { id: string; limitUsd: number; spentUsd: number } | null;
  approveBlocked: string | null;
  reworkBlocked: string | null;
}

export const variantReviewKeys = {
  state: (variantId: string) => ["variant-review", variantId] as const,
};

export const variantReviewApi = {
  state: (variantId: string) => api.get<VariantReviewState>(`/api/variants/${encodeURIComponent(variantId)}/review`),
  /** 素材通过要跑一次文件检查再交给估价（估价在后台跑） */
  approve: (variantId: string) =>
    api.post<VariantReviewState>(`/api/variants/${encodeURIComponent(variantId)}/approve`, undefined, 30_000),
  rework: (variantId: string, note: string) =>
    api.post<VariantReviewState>(`/api/variants/${encodeURIComponent(variantId)}/rework`, { note }, 30_000),
  replace,
};

/** 选图时就地校验，免得传完才被后端拒 */
export function checkImage(file: File): string | undefined {
  const lower = file.name.toLowerCase();
  if (!IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "只收 jpg / png / webp。";
  if (file.size > MAX_IMAGE_BYTES) return `图片 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 20 MB 上限。`;
  if (file.size === 0) return "这是一个空文件。";
  return undefined;
}

/** 替换单张走 multipart（同 evidence 的上传：不用 api.post，那条会 JSON 化 body 并套 5 秒超时；ffmpeg 转换也要时间） */
async function replace(assetId: string, file: File): Promise<{ asset: AssetView }> {
  const form = new FormData();
  form.append("file", file, file.name);
  let res: Response;
  try {
    res = await fetch(`/api/assets/${encodeURIComponent(assetId)}/replace`, { method: "POST", body: form });
  } catch {
    throw new ApiError("替换失败：连不上后端，确认后端在运行后重试。", 0, undefined, "NETWORK");
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
      body?.error?.message ?? `替换失败（HTTP ${res.status}）`,
      res.status,
      text || undefined,
      body?.error?.code,
    );
  }
  return parsed as { asset: AssetView };
}

/** 台词全文按空行分段（SCREEN-007：等宽、按段） */
export function scriptParagraphs(script: string): string[] {
  return script
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
