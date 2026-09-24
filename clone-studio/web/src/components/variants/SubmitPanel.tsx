import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { LANGUAGE_OPTIONS } from "../../lib/evidence.js";
import { BATCH_NOTE_MAX, charCount, checkBriefs, type AgentModelOption, type SubmitInput } from "../../lib/variants.js";
import { Button } from "../ui/Button.js";
import { Input, Textarea } from "../ui/Input.js";
import { Select } from "../ui/Select.js";
import { BatchBudgetBar } from "./BatchBudgetBar.js";
import { BriefEditor } from "./BriefEditor.js";

interface Props {
  /** 模板的语言：目标语言下拉的「同模板」项写明是什么 */
  templateLanguage: string | null;
  models: readonly AgentModelOption[] | undefined;
  /** 设置里的默认批次限额与单条限额（批次限额的下限） */
  defaultBudgetUsd: number;
  perItemLimitUsd: number;
  maxItems: number;
  busy: boolean;
  error: Error | null;
  onSubmit: (input: SubmitInput) => void;
  /** 默认收起（已经有批次时）；空队列时默认展开 */
  defaultOpen: boolean;
}

/** SCREEN-006 上部提交区（可折叠）：brief、目标语言、批次备注、Agent 模型、批次限额、提交 N 条变体 */
export function SubmitPanel(props: Props) {
  const { models, defaultBudgetUsd, perItemLimitUsd, maxItems, busy, error, onSubmit } = props;
  const [open, setOpen] = useState(props.defaultOpen);
  const [briefs, setBriefs] = useState("");
  const [language, setLanguage] = useState("");
  const [note, setNote] = useState("");
  const [model, setModel] = useState("");
  const [budget, setBudget] = useState<string | null>(null);

  const check = checkBriefs(briefs, maxItems);
  const budgetValue = budget === null ? defaultBudgetUsd : Number(budget);
  const budgetError =
    !Number.isFinite(budgetValue) || budgetValue < perItemLimitUsd || budgetValue > 1000
      ? `要在单条限额 $${perItemLimitUsd} 到 $1000 之间`
      : undefined;
  const noteError = charCount(note.trim()) > BATCH_NOTE_MAX ? `最多 ${BATCH_NOTE_MAX} 字` : undefined;
  const blocked =
    check.count === 0
      ? "先写 brief"
      : (check.batchError ?? check.lines[0]?.message ?? budgetError ?? noteError ?? undefined);

  const languageOptions = [
    {
      value: "",
      label: props.templateLanguage
        ? `同模板（${LANGUAGE_OPTIONS.find((o) => o.value === props.templateLanguage)?.label ?? props.templateLanguage}）`
        : "同模板",
    },
    ...LANGUAGE_OPTIONS,
  ];
  const modelOptions = (models ?? [{ id: null, label: "订阅默认模型", disabledReason: null }]).map((m) => ({
    value: m.id ?? "",
    // 不可选的原因写进选项文字：原生下拉不显示 title，读屏也读不到（CMP-010、8.3 审查 MEDIUM-3）
    label: m.disabledReason ? `${m.label}（不可选：${m.disabledReason}）` : m.label,
    ...(m.id ? { detail: m.id } : {}),
    disabled: m.disabledReason !== null,
    ...(m.disabledReason ? { disabledReason: m.disabledReason } : {}),
  }));
  // 服务端逐行校验的结果（提交后）：界面实时校验漏掉的以它为准
  const serverError = error?.message;

  return (
    <section aria-label="提交批量变体" className="rounded-md border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-semibold text-text"
      >
        {open ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />}
        提交批量变体
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
          <BriefEditor value={briefs} onChange={setBriefs} check={check} max={maxItems} disabled={busy} />
          <div className="grid grid-cols-3 gap-3">
            <Select
              label="目标语言"
              value={language}
              onChange={(e) => setLanguage(e.currentTarget.value)}
              options={languageOptions}
              disabled={busy}
            />
            <Select
              label="Agent 模型"
              value={model}
              onChange={(e) => setModel(e.currentTarget.value)}
              options={modelOptions}
              disabled={busy}
              hint="模型档案在设置页落地前，只能在本机订阅下选模型"
            />
            <Input
              label="批次限额 USD"
              type="number"
              mono
              min={perItemLimitUsd}
              max={1000}
              step={0.5}
              value={budget ?? String(defaultBudgetUsd)}
              onChange={(e) => setBudget(e.currentTarget.value)}
              error={budgetError}
              disabled={busy}
            />
          </div>
          <Textarea
            label="批次备注（附加给每一条）"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            placeholder="片尾统一加关注引导"
            hint={`${charCount(note.trim())} / ${BATCH_NOTE_MAX}`}
            error={noteError}
            disabled={busy}
          />
          <div className="flex items-center gap-3">
            <BatchBudgetBar spentUsd={0} limitUsd={Number.isFinite(budgetValue) ? budgetValue : 0} label="这一批限额" />
            {serverError ? (
              <p role="alert" className="text-caption text-danger">
                没有提交：{serverError}
              </p>
            ) : null}
            <Button
              variant="primary"
              className="ml-auto"
              loading={busy}
              disabled={blocked !== undefined}
              disabledReason={blocked}
              onClick={() =>
                onSubmit({
                  briefs,
                  targetLanguage: language || null,
                  note: note.trim() || null,
                  modelId: model || null,
                  budgetUsd: budgetValue,
                })
              }
            >
              提交 {check.count} 条变体
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
