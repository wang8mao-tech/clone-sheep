import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { estimateApi, estimateKeys, type RateInput, type RateUnit } from "../../lib/estimate.js";
import { formatUnitUsd } from "../../lib/format.js";

/**
 * 设置页的费率表（REQ-006「自维护费率表，设置页可编辑」）：一行一个能力的单价。
 * hypit 不出数，估价全靠这张表；缺项一律按「估价拿不到」等人确认，所以表可以是空的，只是会多一步确认。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RatesTable() {
  const qc = useQueryClient();
  const rates = useQuery({ queryKey: estimateKeys.rates, queryFn: () => estimateApi.rates() });
  const invalidate = () => void qc.invalidateQueries({ queryKey: estimateKeys.rates });
  const save = useMutation({ mutationFn: (input: RateInput) => estimateApi.saveRate(input), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: number) => estimateApi.deleteRate(id), onSuccess: invalidate });

  const [capability, setCapability] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [unit, setUnit] = useState<RateUnit>("request");
  const [usd, setUsd] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | undefined>();

  const submit = (): void => {
    const price = Number(usd);
    if (!capability.trim()) return setFormError("能力名不能为空，例如 @hypit/seedance@1#seedance-2-mini");
    // 空着的单价 Number("") 是 0：存成 $0 会把付费能力当免费自动放行，必须拦
    if (!usd.trim() || !Number.isFinite(price) || price < 0 || price > 10_000) {
      return setFormError("单价要是 0 到 10000 之间的数字");
    }
    setFormError(undefined);
    save.mutate(
      { capability: capability.trim(), endpoint: endpoint.trim() || null, unit, usd: price, note: note.trim() || null },
      {
        onSuccess: () => {
          setCapability("");
          setEndpoint("");
          setUsd("");
          setNote("");
        },
      },
    );
  };

  const list = rates.data?.rates ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-text-secondary">
        hypit 只给价格页链接不给数，估价按这里的单价算。表里没有的能力按「估价拿不到」处理，出片前要人确认。
        本地能力默认 $0，写了单价就按写的算。
      </p>
      {rates.error ? (
        <p className="text-caption text-danger">读不到费率表：{rates.error.message}</p>
      ) : list.length === 0 ? (
        <p className="text-caption text-text-tertiary">还没有费率。加一条：能力名 + 单位 + 单价。</p>
      ) : (
        <table className="w-full text-[13px]">
          <thead className="text-caption text-text-tertiary">
            <tr className="text-left">
              <th className="py-1 pr-3 font-medium">能力</th>
              <th className="py-1 pr-3 font-medium">Endpoint</th>
              <th className="py-1 pr-3 font-medium">单位</th>
              <th className="py-1 pr-3 text-right font-medium">单价</th>
              <th className="py-1 pr-3 font-medium">备注</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {list.map((rate) => (
              <tr key={rate.id} className="border-t border-border">
                <td className="max-w-[320px] truncate py-1.5 pr-3 font-mono text-[12px]" title={rate.capability}>
                  {rate.capability}
                </td>
                <td className="py-1.5 pr-3 font-mono text-[12px] text-text-secondary">{rate.endpoint ?? "任意"}</td>
                <td className="py-1.5 pr-3 text-text-secondary">{rate.unit === "second" ? "每秒" : "每次请求"}</td>
                <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{formatUnitUsd(rate.usd)}</td>
                <td
                  className="max-w-[200px] truncate py-1.5 pr-3 text-caption text-text-tertiary"
                  title={rate.note ?? ""}
                >
                  {rate.note ?? ""}
                </td>
                <td className="py-1.5 text-right">
                  <Button
                    variant="ghost"
                    className="h-7 px-2"
                    aria-label={`删除 ${rate.capability} 的费率`}
                    icon={<Trash2 aria-hidden className="size-3.5" />}
                    loading={remove.isPending && remove.variables === rate.id}
                    onClick={() => remove.mutate(rate.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="min-w-[280px] flex-1">
          <Input
            label="能力"
            mono
            placeholder="@hypit/seedance@1#seedance-2-mini"
            value={capability}
            onChange={(e) => setCapability(e.target.value)}
          />
        </div>
        <div className="w-40">
          <Input
            label="Endpoint（可空）"
            mono
            placeholder="tokendance.default"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </div>
        <div className="w-32">
          <Select
            label="单位"
            value={unit}
            onChange={(e) => setUnit(e.target.value as RateUnit)}
            options={[
              { value: "request", label: "每次请求" },
              { value: "second", label: "每秒" },
            ]}
          />
        </div>
        <div className="w-28">
          <Input
            label="单价 USD"
            mono
            inputMode="decimal"
            placeholder="0.28"
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
          />
        </div>
        <div className="w-48">
          <Input
            label="备注（可空）"
            placeholder="价格页 2026-09 的标价"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" loading={save.isPending}>
          保存费率
        </Button>
      </form>
      {(formError ?? save.error ?? remove.error) ? (
        <p role="alert" className="text-caption text-danger">
          {formError ?? messageOf(save.error ?? remove.error)}
        </p>
      ) : null}
    </div>
  );
}
