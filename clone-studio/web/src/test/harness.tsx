import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { vi } from "vitest";
import { routeConfig } from "../app/routes.js";
import { ToastProvider } from "../components/ui/Toast.js";

/** 每个用例一个干净的 QueryClient，免得缓存串场；测试里不重试，失败要立刻看见 */
function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(ui: ReactElement): RenderResult {
  return render(
    <QueryClientProvider client={freshQueryClient()}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

/** 用真实的路由表跑整个应用外壳。测路由的用例必须走这条，不另抄一份配置。 */
export function renderApp(initialPath = "/"): RenderResult {
  const router = createMemoryRouter(routeConfig, { initialEntries: [initialPath] });
  return renderWithProviders(<RouterProvider router={router} />);
}

export interface RouteStub {
  /** 状态码，默认 200 */
  status?: number;
  body: unknown;
}

/**
 * 按 URL 前缀匹配的 fetch 桩。
 *
 * 只桩 fetch 这一层，组件、react-query、路由全是真的——桩得越靠外，
 * 用例覆盖到的真实代码越多。命中不了的请求直接抛，免得静默返回 undefined
 * 把用例变成假绿。
 */
export function stubFetch(routes: Record<string, RouteStub | ((init?: RequestInit) => RouteStub)>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const key = Object.keys(routes)
        // 长前缀优先，否则 /api/clients 会把 /api/clients/:id 的桩吃掉
        .sort((a, b) => b.length - a.length)
        .find((pattern) => {
          const [patternMethod, patternPath] = pattern.includes(" ") ? pattern.split(" ") : ["GET", pattern];
          return patternMethod === method && url.startsWith(patternPath as string);
        });

      if (!key) throw new Error(`用例没有给 ${method} ${url} 准备桩`);
      const stub = routes[key];
      const { status = 200, body } = typeof stub === "function" ? stub(init) : (stub as RouteStub);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

/** 体检与健康检查的默认桩：几乎每个用例都要，但几乎没有用例关心它 */
export const healthStubs = {
  "/api/health/checks": { body: { checks: [], passed: 0, total: 0, blockingFailures: [] } },
  "/api/health": { body: { ok: true, version: "test", host: "127.0.0.1", port: 4310, tables: [] } },
} as const;
