export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 后端返回的错误原文，界面要原样显示，不改写 */
    readonly detail?: string,
    /** 后端的错误码，界面靠它决定就地红字还是 toast */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 默认请求超时。REQ-001 要求「>5 秒显示后端未响应与重试」——后端进程死掉时 fetch
 * 会快速 ECONNREFUSED，但后端 hang 住（TCP 连上不回包）时 fetch 永不 reject，
 * 骨架屏会一直转，那句提示永远不出现。
 *
 * 只对"应当立刻回来"的接口成立。会 spawn 子进程、走网络或要等进程退出的接口
 * 必须单独给更长的值，否则正常的慢会被误报成后端没响应——见 TIMEOUT_MS。
 */
const DEFAULT_TIMEOUT_MS = 5_000;

async function request<T>(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ApiError("后端未响应", 0, undefined, "TIMEOUT");
    }
    throw error;
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
      body?.error?.message ?? `请求失败（HTTP ${res.status}）`,
      res.status,
      text || undefined,
      body?.error?.code,
    );
  }
  return parsed as T;
}

/** 几类慢接口的超时。数值按后端实际上限定，不是拍的。 */
export const TIMEOUT_MS = {
  /** 体检要 spawn 好几个子进程探可执行文件 */
  healthChecks: 60_000,
  /** 凭据验证走外网 */
  verify: 30_000,
  /** 建模板要在磁盘上铺一整个 Hypit 工程目录 */
  createTemplate: 30_000,
  /** 删除最坏要等 10 秒杀进程 + 2 秒强杀宽限，再加移目录与落盘删除 */
  deletion: 60_000,
} as const;

export const api = {
  get: <T>(path: string, timeoutMs?: number) => request<T>(path, undefined, timeoutMs),
  post: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs),
  patch: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs),
  delete: <T>(path: string, timeoutMs?: number) => request<T>(path, { method: "DELETE" }, timeoutMs),
};

export interface Health {
  ok: boolean;
  version: string;
  host: string;
  port: number;
  dataRoot: string;
  hypitRoot: string;
  hypitCliPresent: boolean;
  tables: string[];
}
