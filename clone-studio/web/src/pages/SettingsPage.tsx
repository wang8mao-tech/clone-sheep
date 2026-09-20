import { useQuery } from "@tanstack/react-query";
import { Badge } from "../components/ui/Badge.js";
import { api, type Health } from "../lib/api.js";

/**
 * SCREEN-009 设置页在 Phase 2 实现。
 * Phase 1 先放一个诚实的骨架：显示后端自报的路径与已建表，证明外壳与后端接通了。
 */
export function SettingsPage() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<Health>("/api/health") });

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="flex h-[var(--shell-topbar-height)] shrink-0 items-center border-b border-border px-6">
        <h1 className="text-heading-lg">设置</h1>
      </header>

      <div className="flex flex-col gap-6 p-6">
        <section className="flex flex-col gap-2">
          <h2 className="text-heading-md">后端</h2>
          {health.isPending ? (
            <p className="text-caption text-text-tertiary">读取中…</p>
          ) : health.isError ? (
            <p className="font-mono text-caption text-danger">后端未响应</p>
          ) : (
            <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-text-secondary">监听</dt>
              <dd className="font-mono">
                {health.data.host}:{health.data.port}
              </dd>
              <dt className="text-text-secondary">数据根目录</dt>
              <dd className="font-mono break-all">{health.data.dataRoot}</dd>
              <dt className="text-text-secondary">Hypit 内核</dt>
              <dd className="flex items-center gap-2 font-mono break-all">
                {health.data.hypitRoot}
                <Badge tone={health.data.hypitCliPresent ? "success" : "danger"}>
                  {health.data.hypitCliPresent ? "已就位" : "未找到"}
                </Badge>
              </dd>
              <dt className="text-text-secondary">数据表</dt>
              <dd className="flex flex-wrap gap-1">
                {health.data.tables.map((t) => (
                  <Badge key={t} mono>
                    {t}
                  </Badge>
                ))}
              </dd>
            </dl>
          )}
        </section>

        <p className="text-caption text-text-tertiary">环境体检、生成服务、限额与并发在 Phase 2 接入。</p>
      </div>
    </div>
  );
}
