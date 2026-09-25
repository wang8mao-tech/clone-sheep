import { useQuery } from "@tanstack/react-query";
import { formatUsd } from "../../lib/format.js";
import { outputApi, outputKeys, type OutputCosts } from "../../lib/outputs.js";
import { formatDuration } from "../../lib/run-elapsed.js";
import { Badge } from "../ui/Badge.js";
import { QueryErrorState } from "../ui/QueryErrorState.js";

/**
 * CMP-008 花费明细（REQ-009、AC-024）：Agent 任务（模型、时长、等价花费）与出片（通道 / 模型、估价、实际、build-id）两张表，
 * 两类花费一律带「估」徽标（REQ-009 MUST，不看 isEstimate），给合计。复刻片的复刻会话各版本共用：列出来标「共用」，不进这一条的合计。
 * 有 receipt 链接时给出去，让人去 Provider 侧查真实账单
 */
export function CostBreakdown({ productionId }: { productionId: string }) {
  const costs = useQuery({
    queryKey: outputKeys.costs(productionId),
    queryFn: () => outputApi.costs(productionId),
    retry: false,
  });
  if (costs.isPending) return <p className="text-caption text-text-secondary">读取花费…</p>;
  if (costs.error) {
    return (
      <QueryErrorState
        error={costs.error}
        goneText="这条成片已经不存在了"
        errorText="读不到花费明细"
        retrying={costs.isFetching}
        onRetry={() => void costs.refetch()}
      />
    );
  }
  return <Tables data={costs.data} />;
}

const EST = (
  <Badge tone="warning" title="估算值，以 Provider 侧为准">
    估
  </Badge>
);

function Money({ usd, estimate }: { usd: number | null; estimate?: boolean }) {
  return (
    <span className="inline-flex items-center justify-end gap-1 font-mono whitespace-nowrap tabular-nums">
      {usd === null ? "—" : formatUsd(usd)}
      {estimate && usd !== null ? EST : null}
    </span>
  );
}

function Tables({ data }: { data: OutputCosts }) {
  const th = "px-2 py-1 text-left font-normal text-text-tertiary";
  const td = "px-2 py-1.5 text-text";
  return (
    <section aria-label="花费明细" className="flex flex-col gap-3 text-caption">
      <div className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold text-text">Agent 任务</h3>
        {data.agent.length === 0 ? (
          <p className="text-text-tertiary">这条没有 Agent 任务。</p>
        ) : (
          <table aria-label="Agent 任务花费" className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className={th}>模型</th>
                <th className={th}>时长</th>
                <th className={`${th} text-right`}>等价花费</th>
              </tr>
            </thead>
            <tbody>
              {data.agent.map((a) => (
                <tr key={a.jobId} className="border-b border-border/60">
                  <td className={td}>
                    <span className="font-mono">{a.model ?? "订阅默认模型"}</span>
                    {a.shared ? (
                      <span
                        className="ml-1.5 text-text-tertiary"
                        title="模板的复刻会话，各版本共用，不计入这一条的合计"
                      >
                        共用
                      </span>
                    ) : null}
                  </td>
                  <td className={`${td} font-mono tabular-nums`}>{formatDuration(a.elapsedMs)}</td>
                  <td className={`${td} text-right`}>
                    <Money usd={a.costUsd} estimate />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold text-text">出片</h3>
        {data.builds.length === 0 ? (
          <p className="text-text-tertiary">还没有出过片。</p>
        ) : (
          <table aria-label="出片花费" className="w-full table-fixed border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className={`${th} w-[96px] whitespace-nowrap`}>通道 / 模型</th>
                <th className={`${th} w-[104px] text-right whitespace-nowrap`}>估价</th>
                <th className={`${th} w-[76px] text-right whitespace-nowrap`}>实际</th>
                <th className={th}>build-id</th>
              </tr>
            </thead>
            <tbody>
              {data.builds.map((b) => (
                <tr key={b.buildId} className="border-b border-border/60">
                  {/* 通道一行、模型一行（§10.3 这一列要看得出花在哪个通道），太长的悬停看全文 */}
                  <td
                    className={`${td} break-words whitespace-normal`}
                    title={[b.channel, b.model].filter(Boolean).join(" / ") || "本机渲染"}
                  >
                    {b.channel ?? "本机渲染"}
                    {b.model ? <span className="block font-mono break-all text-text-tertiary">{b.model}</span> : null}
                  </td>
                  <td className={`${td} text-right`}>
                    <Money usd={b.estimateUsd} estimate />
                  </td>
                  <td className={`${td} text-right`}>
                    <Money usd={b.actualUsd} />
                  </td>
                  <td className={`${td} truncate font-mono`} title={b.hypitBuildId ?? undefined}>
                    {/* 只把 http(s) 的当链接：服务端给的地址直接进 href 前挡一道 */}
                    {b.receiptUrl && /^https?:\/\//i.test(b.receiptUrl) ? (
                      <a
                        href={b.receiptUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {b.hypitBuildId ?? b.receiptId ?? "账单"}
                      </a>
                    ) : (
                      (b.hypitBuildId ?? "—")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-2 text-[13px]">
        <span className="text-text-secondary">合计</span>
        {/* 合计含 Agent 等价花费与估价，一律标「估」（REQ-009） */}
        <Money usd={data.totalUsd} estimate />
      </div>
    </section>
  );
}
