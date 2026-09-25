import { KIND_LABEL, type ModelProfile, type ProfilePreset } from "../../lib/model-profiles.js";
import type { Draft, Field } from "../../lib/profile-draft.js";
import { Input } from "../ui/Input.js";

/** 模型档案表单的字段与草稿（右侧面板 ModelProfilePanel 用）：字段随档案类型变 */

export function ProfileForm({
  draft,
  editing,
  preset,
  errors,
  set,
}: {
  draft: Draft;
  editing: ModelProfile | null;
  preset: ProfilePreset | null;
  errors: Partial<Record<Field | "form", string>>;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  const field = (key: Field) => (errors[key] ? { error: errors[key] } : {});
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
      <p className="text-caption text-text-secondary">
        {KIND_LABEL[draft.kind]}
        {preset?.hint ? ` · ${preset.hint}` : ""}
      </p>
      <Input label="档案名" value={draft.name} onChange={(e) => set("name", e.target.value)} {...field("name")} />
      {draft.kind === "compatible" ? (
        <Input
          label="base_url"
          mono
          value={draft.baseUrl}
          onChange={(e) => set("baseUrl", e.target.value)}
          {...field("baseUrl")}
        />
      ) : null}
      {draft.kind !== "subscription" ? (
        <Input
          label="API key"
          mono
          type="password"
          autoComplete="off"
          placeholder={editing?.token ?? ""}
          hint={
            editing
              ? "不填就沿用原来的 key；只存在本机，界面只回打码值"
              : "需要 API key，聊天订阅不可用；只存在本机，界面只回打码值"
          }
          value={draft.token}
          onChange={(e) => set("token", e.target.value)}
          {...field("token")}
        />
      ) : null}
      <Input
        label="主模型 id"
        mono
        value={draft.modelId}
        onChange={(e) => set("modelId", e.target.value)}
        {...field("modelId")}
      />
      {draft.kind !== "subscription" ? (
        <Input
          label="快速模型 id（可空）"
          mono
          hint="轻量调用用；空着就用主模型"
          value={draft.fastModelId}
          onChange={(e) => set("fastModelId", e.target.value)}
        />
      ) : null}
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={draft.supportsVision}
          onChange={(e) => set("supportsVision", e.target.checked)}
          className="size-3.5 accent-primary"
        />
        支持看图（复刻要看参考视频的帧，必须打开）
      </label>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={draft.supportsWebSearch}
          onChange={(e) => set("supportsWebSearch", e.target.checked)}
          className="size-3.5 accent-primary"
        />
        支持联网搜索（关着时 Agent 改用 Bash / WebFetch 找图，素材缺口可能偏多）
      </label>
      {draft.kind === "compatible" ? (
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="输入单价（$ / 百万 token）"
              mono
              inputMode="decimal"
              value={draft.priceIn}
              onChange={(e) => set("priceIn", e.target.value)}
            />
            <Input
              label="输出单价（$ / 百万 token）"
              mono
              inputMode="decimal"
              value={draft.priceOut}
              onChange={(e) => set("priceOut", e.target.value)}
            />
          </div>
          <p className={errors.price ? "text-caption text-danger" : "text-caption text-text-tertiary"}>
            {errors.price ?? "两项都填了才按单价算花费与 $ 熔断；空着就只靠时长与卡死检测"}
          </p>
        </div>
      ) : null}
    </form>
  );
}
