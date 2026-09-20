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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

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

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
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
