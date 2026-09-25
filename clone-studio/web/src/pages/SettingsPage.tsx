import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, RotateCw } from "lucide-react";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { useToast } from "../components/ui/Toast.js";
import { HealthRow } from "../components/HealthRow.js";
import { ModelProfilePanel, type PanelTarget } from "../components/settings/ModelProfilePanel.js";
import { ModelProfiles } from "../components/settings/ModelProfiles.js";
import { GenerationServices } from "../components/settings/GenerationServices.js";
import { RatesTable } from "../components/settings/RatesTable.js";
import { NumberSetting, Section } from "../components/settings/SettingsFields.js";
import { api, TIMEOUT_MS, ApiError } from "../lib/api.js";
import type { HealthSummary, Settings } from "../lib/types.js";

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  /** 添加 / 编辑模型档案的右侧表单面板（SCREEN-009） */
  const [panel, setPanel] = useState<PanelTarget | null>(null);

  const health = useQuery({
    queryKey: ["health", "checks"],
    queryFn: () => api.get<HealthSummary>("/api/health/checks", TIMEOUT_MS.healthChecks),
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });

  const patch = useMutation({
    mutationFn: (body: Partial<Settings>) => api.patch<Settings>("/api/settings", body),
    onSuccess: (next, body) => {
      qc.setQueryData(["settings"], next);
      // 开关 Codex 时服务端会重试同步 Provider 包：体检行的「包没同步上」要跟着变（11.3 第二轮审查 R2-L3）
      if (body.codexProviderEnabled !== undefined) void qc.invalidateQueries({ queryKey: ["health", "checks"] });
    },
    onError: (e: unknown) => {
      const err = e as ApiError;
      toast.push("danger", err.message, err.detail);
    },
  });

  const s = settings.data;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex h-[var(--shell-topbar-height)] shrink-0 items-center justify-between border-b border-border px-6">
        <h1 className="text-heading-lg">设置</h1>
        {health.data ? (
          <span className="text-caption text-text-secondary">
            环境体检 {health.data.passed}/{health.data.total}
          </span>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="页内锚点" className="w-40 shrink-0 border-r border-border p-4">
          <ul className="flex flex-col gap-1 text-[13px]">
            {[
              ["checks", "环境体检"],
              ["services", "生成服务"],
              ["models", "Agent 模型"],
              ["limits", "限额与并发"],
              ["rates", "费率表"],
              ["paths", "路径"],
            ].map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="text-text-secondary hover:text-text">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto p-6">
          <Section
            id="checks"
            title="环境体检"
            action={
              <Button
                icon={<RotateCw aria-hidden className="size-4" />}
                loading={health.isFetching}
                onClick={() => void health.refetch()}
              >
                重新检测
              </Button>
            }
          >
            {health.isPending ? (
              <p className="text-caption text-text-tertiary">检测中…</p>
            ) : health.isError ? (
              <p className="font-mono text-caption text-danger">体检接口未响应</p>
            ) : (
              // 设计稿：体检项直接是卡片里的 36px 行，行间下边线，不再套一层框。
              // 以前每行外面各包一个 div，HealthRow 的 last:border-b-0 对每行都生效，分隔线全没了
              <div>
                {health.data.checks.map((c) => (
                  <HealthRow key={c.id} check={c} />
                ))}
              </div>
            )}
          </Section>

          <Section id="services" title="生成服务">
            <GenerationServices
              settings={s}
              codexCheck={health.data?.checks.find((c) => c.id === "codex")}
              saving={patch.isPending}
              onPatch={(body) => patch.mutate(body)}
            />
          </Section>

          <Section
            id="models"
            title="Agent 模型"
            action={
              <Button
                icon={<Plus aria-hidden className="size-4" />}
                onClick={(e) => setPanel({ mode: "create", opener: e.currentTarget })}
              >
                添加模型
              </Button>
            }
          >
            <ModelProfiles
              onEdit={(profile, opener) => setPanel({ mode: "edit", profile, opener })}
              onDeleted={(id) => setPanel((p) => (p?.mode === "edit" && p.profile.id === id ? null : p))}
            />
          </Section>

          <Section id="limits" title="限额与熔断 · 并发">
            {s ? (
              <div className="flex flex-wrap gap-4">
                <NumberSetting
                  label="单条限额"
                  suffix="USD"
                  value={s.perItemLimitUsd}
                  min={0}
                  max={100}
                  step={0.5}
                  onCommit={(v) => patch.mutate({ perItemLimitUsd: v })}
                />
                <NumberSetting
                  label="批次限额"
                  suffix="USD"
                  value={s.batchLimitUsd}
                  min={0}
                  max={1000}
                  step={1}
                  onCommit={(v) => patch.mutate({ batchLimitUsd: v })}
                />
                <NumberSetting
                  label="Agent 熔断"
                  suffix="分钟"
                  value={s.agentTimeoutMinutes}
                  min={1}
                  max={600}
                  onCommit={(v) => patch.mutate({ agentTimeoutMinutes: v })}
                />
                <NumberSetting
                  label="Agent 熔断"
                  suffix="USD"
                  value={s.agentBudgetUsd}
                  min={0}
                  max={1000}
                  step={0.5}
                  onCommit={(v) => patch.mutate({ agentBudgetUsd: v })}
                />
                <NumberSetting
                  label="Agent 并发"
                  value={s.agentConcurrency}
                  min={1}
                  max={16}
                  onCommit={(v) => patch.mutate({ agentConcurrency: v })}
                />
                <NumberSetting
                  label="渲染并发"
                  value={s.renderConcurrency}
                  min={1}
                  max={8}
                  onCommit={(v) => patch.mutate({ renderConcurrency: v })}
                />
                <NumberSetting
                  label="渲染 workers"
                  value={s.renderWorkers}
                  min={1}
                  max={32}
                  onCommit={(v) => patch.mutate({ renderWorkers: v })}
                />
              </div>
            ) : null}
          </Section>

          <Section id="rates" title="费率表 · 估价">
            <RatesTable />
          </Section>

          <Section id="paths" title="路径">
            {s ? (
              <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1 text-[13px]">
                <dt className="text-text-secondary">数据根目录</dt>
                <dd className="font-mono break-all">{s.paths.dataRoot}</dd>
                <dt className="text-text-secondary">Hypit 内核</dt>
                <dd className="font-mono break-all">{s.paths.hypitRoot}</dd>
                <dt className="text-text-secondary">密钥文件</dt>
                <dd className="flex items-center gap-2 font-mono break-all">
                  {s.paths.secrets}
                  <Badge tone="neutral">仅当前用户可读</Badge>
                </dd>
              </dl>
            ) : null}
          </Section>
        </div>
      </div>
      {panel ? (
        <ModelProfilePanel
          key={panel.mode === "edit" ? panel.profile.id : "create"}
          target={panel}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </div>
  );
}
