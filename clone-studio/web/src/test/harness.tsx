import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { vi } from "vitest";
import type { Health } from "../lib/api.js";
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

/** 逐段比对，`:name` 吃一整段。段数不同直接不匹配。 */
function pathMatches(pattern: string, url: string): boolean {
  const p = pattern.split("/");
  const u = url.split("/");
  if (p.length !== u.length) return false;
  // `:占位` 必须吃到非空的一段：不加这条的话 "/api/clients/" 会被
  // "/api/clients/:id" 当成"空 id"匹配上，安静地返回一份客户详情
  return p.every((seg, i) => (seg.startsWith(":") ? u[i] !== "" : seg === u[i]));
}

export interface RouteStub {
  /** 状态码，默认 200 */
  status?: number;
  body: unknown;
}

/**
 * fetch 桩。键写成 "GET /api/clients" 或 "/api/clients"（省略即 GET）。
 *
 * 只桩 fetch 这一层，组件、react-query、路由全是真的——桩得越靠外，
 * 用例覆盖到的真实代码越多。命中不了的请求直接抛，免得静默返回 undefined
 * 把用例变成假绿。
 *
 * **按整条路径精确匹配，不做前缀匹配。** 前缀匹配看着方便，实际会静默串桩：
 * 只桩了 /api/clients 时，请求 /api/clients/abc/deletion-impact 会拿到客户列表
 * 并返回 200，连 /api/clientsXYZ 这种完全不同的路径也照收——那道"没桩就抛"的
 * 闸门根本轮不到执行，而这恰恰是最容易变成假绿的一半。
 * 要匹配动态段就在键里写 `:name` 占位，如 "/api/clients/:id/deletion-impact"。
 */
export function stubFetch(routes: Record<string, RouteStub | ((init?: RequestInit, url?: string) => RouteStub)>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = raw.split("?")[0] as string;
      const method = (init?.method ?? "GET").toUpperCase();

      const key = Object.keys(routes)
        // 精确键优先于带 :占位 的键，否则 "/api/templates/:id" 会把
        // "/api/templates/<具体 id>" 的桩抢走
        .sort((a, b) => (a.match(/:/g)?.length ?? 0) - (b.match(/:/g)?.length ?? 0))
        .find((pattern) => {
          const [patternMethod, patternPath] = pattern.includes(" ") ? pattern.split(" ") : ["GET", pattern];
          if (patternMethod !== method) return false;
          return pathMatches(patternPath as string, url);
        });

      if (!key) throw new Error(`用例没有给 ${method} ${url} 准备桩`);
      const stub = routes[key];
      // 函数桩第二个参数给完整地址（含查询串）：分页之类的桩要按参数回不同的页
      const { status = 200, body } = typeof stub === "function" ? stub(init, raw) : (stub as RouteStub);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

/**
 * 体检与健康检查的默认桩：几乎每个用例都要，但几乎没有用例关心它。
 * body 要和 `Health` 接口逐字段对齐——桩的类型是宽松的，tsc 看不见缺字段，
 * 将来有组件读 dataRoot 之类会拿到 undefined 而不报错。
 */
export const healthStubs: Record<string, RouteStub> = {
  "/api/health/checks": { body: { checks: [], passed: 0, total: 0, blockingFailures: [] } },
  "/api/health": {
    body: {
      ok: true,
      version: "test",
      host: "127.0.0.1",
      port: 4310,
      dataRoot: "C:/test/.clone-studio",
      hypitRoot: "C:/test/hypit-main",
      hypitCliPresent: true,
      tables: [],
    } satisfies Health,
  },
};
