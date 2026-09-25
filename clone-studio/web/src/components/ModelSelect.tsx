import { useState } from "react";
import { Link } from "react-router";
import { KIND_LABEL, type ModelProfile } from "../lib/model-profiles.js";
import {
  isClaudeProfile,
  markNonClaudeNoticeSeen,
  nonClaudeNoticeSeen,
  profileBlocker,
  type ProfileNeed,
} from "../lib/profile-choice.js";
import { Badge } from "./ui/Badge.js";
import { Select } from "./ui/Select.js";

/**
 * CMP-010 模型档案选择器（Design-Brief：档案名 + 模型 id 小字 + 能力徽标；不满足当前任务要求的项置灰并附原因；
 * 底部「管理模型…」跳设置）。用原生下拉（④ 的先例，8.3 审查）：置灰原因写进选项文字，读屏读得到；
 * 能力徽标原生选项里放不下，挂在下拉下面、跟着当前选中的档案走
 */
export function ModelSelect({
  profiles,
  value,
  onChange,
  need = null,
  disabled = false,
  label = "Agent 模型",
  error = null,
  onRetry,
  fallbackText = "提交时会用默认档案。",
}: {
  profiles: readonly ModelProfile[] | undefined;
  value: string | null;
  onChange: (id: string) => void;
  need?: ProfileNeed;
  disabled?: boolean;
  label?: string;
  /** 档案列表读不到：写明、给重试，不停在「读取中」（10.4 审查 S2-M1） */
  error?: Error | null;
  onRetry?: () => void;
  /** 读不到档案时实际会发生什么（提交用默认档案；重跑沿用原档案，10.4 第二轮审查 S1-M-B） */
  fallbackText?: string;
}) {
  const [noticeSeen, setNoticeSeen] = useState(nonClaudeNoticeSeen);
  const list = profiles ?? [];
  const selected = list.find((p) => p.id === value);
  const options = list.map((p) => {
    const blocker = profileBlocker(p, need);
    return {
      value: p.id,
      label: blocker ? `${p.name}（不可选：${blocker}）` : p.name,
      detail: p.modelId ?? "订阅默认模型",
      disabled: blocker !== null,
      ...(blocker ? { disabledReason: blocker } : {}),
    };
  });

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Select
        label={label}
        value={value ?? ""}
        onChange={(e) => onChange(e.currentTarget.value)}
        options={
          profiles ? options : [{ value: "", label: error ? "读不到模型档案" : "读取模型档案…", disabled: true }]
        }
        disabled={disabled || !profiles}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-1 text-caption">
        {selected ? (
          <>
            <Badge tone="neutral">{KIND_LABEL[selected.kind]}</Badge>
            {selected.supportsVision ? <Badge tone="info">看图</Badge> : null}
            {selected.supportsWebSearch ? <Badge tone="info">搜索</Badge> : null}
          </>
        ) : null}
        <Link to="/settings#models" className="ml-auto text-text-secondary hover:text-text hover:underline">
          管理模型…
        </Link>
      </div>
      {!profiles && error ? (
        <p role="alert" className="flex items-center gap-2 text-caption text-danger">
          读不到模型档案：{error.message}。{fallbackText}
          {onRetry ? (
            <button type="button" onClick={onRetry} className="text-text-secondary hover:text-text hover:underline">
              重试
            </button>
          ) : null}
        </p>
      ) : null}
      {profiles && !list.some((p) => profileBlocker(p, need) === null) ? (
        <p role="alert" className="text-caption text-danger">
          {need === "vision"
            ? "没有支持看图的模型档案：复刻要看参考视频的帧，去设置里打开某个档案的「支持看图」或添加一个。"
            : "没有能用的模型档案：去设置里给某个档案补上 API key。"}
        </p>
      ) : null}
      {selected && need === null && !selected.supportsVision ? (
        <p className="text-caption text-warning">
          这个档案不支持看图：Agent 没法自己核对找来的图，素材审核时多看一眼。
        </p>
      ) : null}
      {selected && !selected.supportsWebSearch ? (
        <p className="text-caption text-text-secondary">
          没有原生联网搜索：Agent 会改用命令行与网页抓取找图，素材缺口可能偏多。
        </p>
      ) : null}
      {selected && !isClaudeProfile(selected) && !noticeSeen ? (
        <div
          role="note"
          className="flex flex-col gap-1 rounded-md border border-warning/40 bg-bg p-2 text-caption text-warning"
        >
          <span>
            hypit skill 是按 Claude Code / Codex 级别的 Agent 设计的，换成别家模型后 check
            通过率和验货通过率会明显下降。
          </span>
          <button
            type="button"
            className="self-end text-text-secondary hover:text-text hover:underline"
            onClick={() => {
              markNonClaudeNoticeSeen();
              setNoticeSeen(true);
            }}
          >
            知道了
          </button>
        </div>
      ) : null}
    </div>
  );
}
