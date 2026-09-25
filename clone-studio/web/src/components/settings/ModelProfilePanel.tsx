import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../lib/api.js";
import { profileApi, profileKeys, type ModelProfile, type ProfilePreset } from "../../lib/model-profiles.js";
import { Button } from "../ui/Button.js";
import { QueryErrorState } from "../ui/QueryErrorState.js";
import { FIELD_OF, fromPreset, fromProfile, price, type Draft, type Field } from "../../lib/profile-draft.js";
import { ProfileForm } from "./ModelProfileForm.js";

/**
 * 添加 / 编辑模型档案的右侧表单面板（Design-Brief：弹窗只用于危险确认与成片播放，添加模型用右侧表单面板）。
 * 添加先选预设（预设旁固定一行「需要 API key，聊天订阅不可用」），再填表；字段随类型变：
 * 订阅只要名称与模型，官方 key 加 key，兼容端点再加 base_url 与单价（花费按单价折算，REQ-010）
 */
export type PanelTarget = ({ mode: "create" } | { mode: "edit"; profile: ModelProfile }) & {
  /** 是谁打开的：关掉时焦点还给它（换目标重开时各还各的，10.3 第二轮审查 S2-L1） */
  opener?: HTMLElement | null;
};

export function ModelProfilePanel({ target, onClose }: { target: PanelTarget; onClose: () => void }) {
  const qc = useQueryClient();
  // 编辑用不上预设，不去拉（10.3 第二轮审查 S2-M4-R）
  const presets = useQuery({
    queryKey: profileKeys.presets,
    queryFn: () => profileApi.presets(),
    enabled: target.mode === "create",
  });
  const editing = target.mode === "edit" ? target.profile : null;
  const [draft, setDraft] = useState<Draft | null>(editing ? fromProfile(editing) : null);
  const [preset, setPreset] = useState<ProfilePreset | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Field | "form", string>>>({});
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 面板不是模态的：它开着时还能在后面的行上点「删除」弹出确认框。那个框自己处理 Esc，
      // 这里不能跟着把面板和没保存的草稿一起关掉（10.3 审查 S2-M1）
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("dialog[open]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // 关掉时焦点还给打开它的那个按钮（10.3 审查 S2-M4）
  const opener = target.opener;
  useEffect(() => () => opener?.focus(), [opener]);
  // 换一屏（选预设 → 填表）、预设读到了，都把焦点放到第一个能操作的地方
  const stage = draft === null ? "pick" : "form";
  // 只在面板自己的内容区里找（面板在外壳的 <main> 里，按整份文档匹配会先撞上头部的「关闭」，10.3 第二轮审查 S2-M4-R）；
  // 预设晚到只在选预设那一屏才重新落焦，不把人已经挪走的焦点抢回来
  const waitingPresets = stage === "pick" && presets.data === undefined;
  useEffect(() => {
    (body.current?.querySelector<HTMLElement>("input, button") ?? panel.current)?.focus();
  }, [stage, waitingPresets]);

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const body = {
        name: d.name,
        ...(d.kind === "compatible"
          ? { baseUrl: d.baseUrl, priceIn: price(d.priceIn), priceOut: price(d.priceOut) }
          : {}),
        ...(d.kind !== "subscription" && d.token.trim() ? { token: d.token } : {}),
        modelId: d.modelId,
        fastModelId: d.fastModelId || null,
        supportsVision: d.supportsVision,
        supportsWebSearch: d.supportsWebSearch,
      };
      return editing ? profileApi.update(editing.id, body) : profileApi.create({ ...body, kind: d.kind });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: profileKeys.list });
      onClose();
    },
    onError: (e: Error) => {
      const field = e instanceof ApiError && e.code ? FIELD_OF[e.code] : undefined;
      setErrors(field ? { [field]: e.message } : { form: e.message });
    },
  });

  const submit = (): void => {
    if (!draft) return;
    const next: typeof errors = {};
    const nameLength = [...draft.name.trim()].length;
    if (nameLength < 1 || nameLength > 30) next.name = "档案名要 1-30 字";
    if (!draft.modelId.trim()) next.modelId = "要填主模型 id";
    if (draft.kind === "compatible" && !/^https?:\/\//i.test(draft.baseUrl.trim()))
      next.baseUrl = "要是 http 或 https 地址";
    if (draft.kind !== "subscription" && !editing && !draft.token.trim()) next.token = "要填 API key";
    for (const text of [draft.priceIn, draft.priceOut]) {
      const value = price(text);
      if (value !== null && (!Number.isFinite(value) || value < 0)) next.price = "单价要是不小于 0 的数";
    }
    setErrors(next);
    if (Object.keys(next).length === 0) save.mutate(draft);
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
  const title = editing ? `编辑「${editing.name}」` : draft ? `添加 · ${preset?.label ?? ""}` : "添加模型";

  return (
    <aside
      ref={panel}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      className="elevation-overlay fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col border-l border-border bg-surface"
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="truncate text-[14px] font-semibold">{title}</h2>
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </header>

      <main ref={body} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {draft === null ? (
          presets.error ? (
            <QueryErrorState
              error={presets.error}
              goneText="读不到预设"
              errorText="读不到预设"
              retrying={presets.isFetching}
              onRetry={() => void presets.refetch()}
            />
          ) : presets.isPending ? (
            <ul aria-label="读取预设" aria-busy className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <li key={i} className="h-14 animate-pulse rounded-md bg-bg" />
              ))}
            </ul>
          ) : (
            <>
              <p className="text-caption text-warning">{presets.data?.note ?? "需要 API key，聊天订阅不可用"}</p>
              <ul aria-label="预设" className="flex flex-col gap-2">
                {(presets.data?.presets ?? []).map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setPreset(p);
                        setDraft(fromPreset(p));
                      }}
                      className="flex w-full flex-col gap-0.5 rounded-md border border-border bg-bg px-3 py-2 text-left hover:bg-surface-raised"
                    >
                      <span className="text-[13px] font-medium text-text">{p.label}</span>
                      <span className="text-caption text-text-secondary">{p.hint}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : (
          <ProfileForm draft={draft} editing={editing} preset={preset} errors={errors} set={set} />
        )}
      </main>

      {draft ? (
        <footer className="flex shrink-0 flex-col gap-2 border-t border-border p-4">
          {errors.form ? <p className="text-caption text-danger">{errors.form}</p> : null}
          <div className="flex justify-end gap-2">
            {editing ? null : (
              <Button variant="ghost" onClick={() => setDraft(null)}>
                换预设
              </Button>
            )}
            <Button variant="primary" loading={save.isPending} onClick={submit}>
              保存
            </Button>
          </div>
        </footer>
      ) : null}
    </aside>
  );
}
