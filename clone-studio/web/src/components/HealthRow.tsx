import { useState } from "react";
import { Check, Copy, Loader2, TriangleAlert, X } from "lucide-react";

export type CheckStatus = "pass" | "fail" | "warn" | "checking";

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string | null;
  blocking: boolean;
  /** 可选项专用：虽没全过，但能启用（Codex：CLI 与登录都好，只是 Provider 包没同步上，启用时会重试同步） */
  ready?: boolean;
}

function Icon({ status }: { status: CheckStatus }) {
  if (status === "checking") return <Loader2 aria-hidden className="size-4 animate-spin text-text-tertiary" />;
  if (status === "pass") return <Check aria-hidden className="size-4 text-success" />;
  if (status === "warn") return <TriangleAlert aria-hidden className="size-4 text-warning" />;
  return <X aria-hidden className="size-4 text-danger" />;
}

const LABEL: Record<CheckStatus, string> = {
  pass: "通过",
  fail: "未通过",
  warn: "可选项未就绪",
  checking: "检测中",
};

/** CMP-011 体检行：图标 + 名称 + 现状 + 修复命令（等宽、可复制） */
export function HealthRow({ check }: { check: CheckResult }) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    if (!check.fix) return;
    try {
      await navigator.clipboard.writeText(check.fix);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板被拒就算了，命令本身是可见的，用户能自己选
    }
  };

  return (
    <div className="flex min-h-[var(--row-height)] items-center gap-3 border-b border-border py-1.5">
      <span className="flex w-4 shrink-0 justify-center">
        <Icon status={check.status} />
      </span>
      <span className="sr-only">{LABEL[check.status]}</span>
      <span className="w-52 shrink-0 text-[13px]">{check.name}</span>
      <span
        className={[
          "flex-1 truncate text-[13px]",
          check.status === "fail" ? "text-danger" : check.status === "warn" ? "text-warning" : "text-text-secondary",
        ].join(" ")}
        title={check.detail}
      >
        {check.detail}
      </span>
      {check.fix ? (
        <button
          type="button"
          onClick={() => void copy()}
          title="复制修复命令"
          className="flex max-w-[380px] items-center gap-2 rounded-sm border border-border px-2 py-1 font-mono text-caption text-text-secondary hover:bg-surface-raised hover:text-text"
        >
          <span className="truncate">{check.fix}</span>
          {copied ? (
            <Check aria-hidden className="size-3.5 shrink-0 text-success" />
          ) : (
            <Copy aria-hidden className="size-3.5 shrink-0" />
          )}
        </button>
      ) : null}
    </div>
  );
}
