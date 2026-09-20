import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate } from "react-router";
import { AgentDrawer } from "./AgentDrawer.js";
import { Sidebar, type SidebarClient } from "./Sidebar.js";
import { DesktopOnlyGate } from "./DesktopOnlyGate.js";
import { api, type Health } from "../lib/api.js";
import { useSse } from "../lib/useSse.js";

export function Shell() {
  const navigate = useNavigate();

  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<Health>("/api/health"),
    retry: 1,
    refetchInterval: 30_000,
  });

  // 客户树的数据接口在 Phase 3 才有，这里先给空列表，外壳照常渲染。
  const clients: SidebarClient[] = [];

  useSse(["global"], () => {
    void health.refetch();
  });

  return (
    <DesktopOnlyGate>
      <div className="flex h-full w-full overflow-hidden bg-bg">
        <Sidebar
          clients={clients}
          loading={false}
          error={health.isError ? "后端未响应" : undefined}
          onRetry={() => void health.refetch()}
          onNewClient={() => void navigate("/")}
          healthOk={health.data?.ok === true}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
        <AgentDrawer />
      </div>
    </DesktopOnlyGate>
  );
}
