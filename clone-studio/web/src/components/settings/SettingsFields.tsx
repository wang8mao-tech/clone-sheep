import { useState } from "react";
import { Input } from "../ui/Input.js";

/** 设置页的两个基础件：分组卡片与「失焦即存」的数字项。从 SettingsPage 拆出来，页面文件保持在 300 行内 */

export function Section({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // 设计稿「设置」：每组是一张 surface 卡片，44px 标题行带下边线。字段用 bg 色底，
    // 放在卡片里才分得出来（Task 4.4 把共用字段底色改成 bg 后，裸放会与页面同色）
    <section id={id} className="flex scroll-mt-6 flex-col rounded-lg border border-border bg-surface">
      <div className="flex h-11 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {action}
      </div>
      <div className="flex flex-col gap-3 px-4 pt-2 pb-3.5">{children}</div>
    </section>
  );
}

/** 数字设置项：失焦即存（设计稿"改完即存"） */
export function NumberSetting({
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
