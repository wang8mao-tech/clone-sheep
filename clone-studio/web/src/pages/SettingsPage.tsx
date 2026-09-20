import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { RotateCw } from "lucide-react";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Input.js";
import { useToast } from "../components/ui/Toast.js";
import { HealthRow } from "../components/HealthRow.js";
import { api, ApiError } from "../lib/api.js";
import type { HealthSummary, Settings, VerifyResult } from "../lib/types.js";

function Section({ id, title, action, children }: {
  id: string;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex h-8 items-center justify-between">
        <h2 className="text-heading-md">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 数字设置项：失焦即存（设计稿"改完即存"） */
function NumberSetting({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | undefined>();

  const commit = (): void => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      setError(`需在 ${min} 到 ${max} 之间`);
      return;
    }
    setError(undefined);
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <div className="w-44">
      <Input
        label={suffix ? `${label}（${suffix}）` : label}
        mono
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        error={error}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </div>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [tokenDraft, setTokenDraft] = useState("");

  const health = useQuery({
    queryKey: ["health", "checks"],
    queryFn: () => api.get<HealthSummary>("/api/health/checks"),
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });

  const patch = useMutation({
    mutationFn: (body: Partial<Settings>) => api.patch<Settings>("/api/settings", body),
    onSuccess: (next) => qc.setQueryData(["settings"], next),
    onError: (e: unknown) => {
      const err = e as ApiError;
      toast.push("danger", err.message, err.detail);
    },
  });

  const saveSecret = useMutation({
    mutationFn: (value: string | null) =>
      api.post<{ masked: string | null }>("/api/settings/secret", { key: "tokendance.apiKey", value }),
    onSuccess: () => {
      setTokenDraft("");
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["health", "checks"] });
    },
  });

  const verify = useMutation({
    mutationFn: () => api.post<VerifyResult>("/api/settings/verify/tokendance"),
    onSuccess: (result) => {
      if (result.ok) {
        toast.push("success", "TokenDance key 验证通过");
      } else {
        // 验证失败要显示服务端返回的原因原文（AC-023）
        const reason =
          [result.status ? `HTTP ${result.status}` : null, result.detail, result.error]
            .filter(Boolean)
            .join("\n") || "未给出原因";
        toast.push("danger", "TokenDance key 验证失败", reason);
      }
      void qc.invalidateQueries({ queryKey: ["health", "checks"] });
    },
    onError: (e: unknown) => {
      const err = e as ApiError;
      toast.push("danger", "验证请求失败", err.detail ?? err.message);
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
              ["limits", "限额与并发"],
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

        <div className="flex min-w-0 flex-1 flex-col gap-8 overflow-y-auto p-6">
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
              <div className="rounded-md border border-border">
                {health.data.checks.map((c) => (
                  <div key={c.id} className="px-3">
                    <HealthRow check={c} />
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section id="services" title="生成服务">
            <div className="flex flex-col gap-3 rounded-md border border-border p-4">
              <div className="flex items-end gap-3">
                <div className="w-80">
                  <Input
                    label="TokenDance API key"
                    mono
                    type="password"
                    autoComplete="off"
                    placeholder={s?.credentials.tokendance ?? "未配置"}
                    value={tokenDraft}
                    onChange={(e) => setTokenDraft(e.target.value)}
                    hint={s?.credentials.tokendance ? `已保存：${s.credentials.tokendance}` : "只存在本机，界面只回打码值"}
                  />
                </div>
                <Button
                  variant="secondary"
                  loading={saveSecret.isPending}
                  disabled={tokenDraft.trim().length === 0}
                  disabledReason="先填入 key"
                  onClick={() => saveSecret.mutate(tokenDraft)}
                >
                  保存
                </Button>
                <Button
                  variant="primary"
                  loading={verify.isPending}
                  disabled={!s?.credentials.tokendance}
                  disabledReason="先保存一个 key"
                  onClick={() => verify.mutate()}
                >
                  验证
                </Button>
                {s?.credentials.tokendance ? (
                  <Button
                    variant="ghost"
                    onClick={() => saveSecret.mutate(null)}
                    loading={saveSecret.isPending}
                  >
                    清除
                  </Button>
                ) : null}
              </div>
              <p className="text-caption text-text-tertiary">
                HypiHub（可选，补配音 TTS 等）的浏览器授权连接在 Phase 6 接入。
              </p>
            </div>
          </Section>

          <Section id="limits" title="限额与熔断 · 并发">
            {s ? (
              <div className="flex flex-wrap gap-4 rounded-md border border-border p-4">
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

          <Section id="paths" title="路径">
            {s ? (
              <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1 rounded-md border border-border p-4 text-[13px]">
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
    </div>
  );
}
