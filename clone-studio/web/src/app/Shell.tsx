import { useQuery } from "@tanstack/react-query";
import { Outlet, useMatch } from "react-router";
import { Sidebar } from "./Sidebar.js";
import { DesktopOnlyGate } from "./DesktopOnlyGate.js";
import { AgentDrawer } from "../components/agent/AgentDrawer.js";
import { HealthBanner } from "../components/HealthBanner.js";
import { api, TIMEOUT_MS, type Health } from "../lib/api.js";
import { archiveApi, archiveKeys } from "../lib/archive.js";
import type { HealthSummary } from "../lib/types.js";
import { useInvalidateArchive } from "../lib/useArchive.js";
import { useSse } from "../lib/useSse.js";

export function Shell() {
  const invalidateArchive = useInvalidateArchive();
  // 抽屉挂在外壳上、在路由出口之外，拿不到子路由的 params，只好自己匹配一次
  const templateId = useMatch("/clients/:clientId/templates/:templateId/*")?.params.templateId;

  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<Health>("/api/health"),
    retry: 1,
    refetchInterval: 30_000,
  });

  const checks = useQuery({
    queryKey: ["health", "checks"],
    queryFn: () => api.get<HealthSummary>("/api/health/checks", TIMEOUT_MS.healthChecks),
    // 体检要 spawn 好几个子进程，别频繁重跑
    staleTime: 60_000,
  });

  const clients = useQuery({
    queryKey: archiveKeys.clients,
    queryFn: () => archiveApi.listClients(),
  });

  useSse(["global"], (event) => {
    // 归档结构变了只重拉归档；体检要 spawn 子进程，别被它连累
    if (event === "archive") {
      invalidateArchive();
      return;
    }
    void health.refetch();
    void checks.refetch();
  });

  // 后端整个不响应时，侧栏那条红条说的是同一件事，别让客户树再喊一遍
  const sidebarError = health.isError ? "后端未响应" : clients.isError ? clients.error.message : undefined;

  return (
    <DesktopOnlyGate>
      <div className="flex h-full w-full overflow-hidden bg-bg">
        <Sidebar
          clients={clients.data?.clients ?? []}
          loading={clients.isLoading}
          error={sidebarError}
          onRetry={() => {
            void health.refetch();
            void clients.refetch();
          }}
          healthOk={(checks.data?.blockingFailures.length ?? 0) === 0 && health.data?.ok === true}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <HealthBanner failures={checks.data?.blockingFailures ?? []} />
          <Outlet />
        </main>
        <AgentDrawer templateId={templateId} />
      </div>
    </DesktopOnlyGate>
  );
}
