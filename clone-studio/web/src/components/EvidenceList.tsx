import { useEffect, useState } from "react";
import { Check, Loader2, RotateCcw, Upload, X } from "lucide-react";
import { Button } from "./ui/Button.js";
import {
  describeProbe,
  EVIDENCE_LABELS,
  formatElapsed,
  type EvidenceState,
  type EvidenceStep,
  type EvidenceStepRecord,
} from "../lib/evidence.js";

interface Props {
  state: EvidenceState;
  /** 正在重试哪一步：按钮转圈，其余重试按钮一并禁用 */
  retrying?: EvidenceStep;
  onRetry: (step: EvidenceStep) => void;
  /** 链接导入失败时给的出路：切到上传（REQ-002 输入表「失败提示改为上传」） */
  onSwitchToUpload?: () => void;
}

/**
 * 证据准备清单（SCREEN-003 右侧）：下载 / 探测 / 转写 / 抽帧。
 *
 * 每行 36px，状态图标 + 名称 + 附注 + 耗时（设计稿「① 参考」）。
 * 失败或超时的那一行变红并就地展开错误原文与「重试此步」（REQ-002 错误态）。
 */
export function EvidenceList({ state, retrying, onRetry, onSwitchToUpload }: Props) {
  const running = state.steps.some((s) => s.status === "running");
  const now = useTicker(running);

  return (
    <ol aria-label="证据准备清单" className="flex flex-col">
      {state.steps.map((step) => (
        <EvidenceRow
          key={step.step}
          step={step}
          note={noteFor(step, state)}
          now={now}
          retrying={retrying === step.step}
          retryDisabled={Boolean(retrying) || running}
          onRetry={() => onRetry(step.step)}
          onSwitchToUpload={step.step === "fetch" ? onSwitchToUpload : undefined}
        />
      ))}
    </ol>
  );
}

interface RowProps {
  step: EvidenceStepRecord;
  note?: string;
  now: number;
  retrying: boolean;
  retryDisabled: boolean;
  onRetry: () => void;
  onSwitchToUpload?: () => void;
}

function EvidenceRow({ step, note, now, retrying, retryDisabled, onRetry, onSwitchToUpload }: RowProps) {
  const broken = step.status === "failed" || step.status === "timeout";
  const label = EVIDENCE_LABELS[step.step];

  return (
    <li className="border-b border-border" aria-label={`${label}：${STATUS_TEXT[step.status]}`}>
      <div className="flex h-9 items-center gap-2.5">
        <StepIcon status={step.status} />
        <span
          className={[
            "min-w-0 flex-1 truncate text-[13px]",
            step.status === "pending" ? "text-text-tertiary" : broken ? "text-danger" : "text-text",
          ].join(" ")}
        >
          {label}
        </span>
        {note ? <span className="shrink-0 text-caption text-text-secondary">{note}</span> : null}
        <span className="w-10 shrink-0 text-right font-mono text-caption text-text-secondary tabular-nums">
          {elapsedOf(step, now)}
        </span>
      </div>

      {broken ? (
        <div className="mb-3 flex flex-col gap-2 rounded-md border border-danger/40 bg-danger/10 p-3">
          <p role="alert" className="font-mono text-caption break-all whitespace-pre-wrap text-danger">
            {step.errorCode ? <span className="mr-2">{step.errorCode}</span> : null}
            {step.errorMessage ?? "这一步失败了，后端没有给出原因。"}
          </p>
          {step.errorRaw ? (
            <details className="text-caption text-text-secondary">
              <summary className="cursor-pointer select-none">原始输出</summary>
              <pre className="mt-1 max-h-48 overflow-auto font-mono break-all whitespace-pre-wrap">{step.errorRaw}</pre>
            </details>
          ) : null}
          {onSwitchToUpload ? (
            <p className="text-caption text-text-secondary">链接下载不下来的话，可以改为上传视频文件后重新提交。</p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              icon={<RotateCcw aria-hidden className="size-4" />}
              loading={retrying}
              disabled={retryDisabled}
              disabledReason="有步骤正在跑，等它结束"
              onClick={onRetry}
            >
              重试此步
            </Button>
            {onSwitchToUpload ? (
              <Button variant="ghost" icon={<Upload aria-hidden className="size-4" />} onClick={onSwitchToUpload}>
                改为上传文件
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

const STATUS_TEXT: Record<EvidenceStepRecord["status"], string> = {
  pending: "等待",
  running: "进行中",
  done: "完成",
  failed: "失败",
  timeout: "超时",
};

function StepIcon({ status }: { status: EvidenceStepRecord["status"] }) {
  const box = "flex size-3.5 shrink-0 items-center justify-center";
  switch (status) {
    case "done":
      return <Check aria-hidden className={`${box} text-success`} />;
    case "running":
      return <Loader2 aria-hidden className={`${box} animate-spin text-primary`} />;
    case "failed":
    case "timeout":
      return <X aria-hidden className={`${box} text-danger`} />;
    default:
      return (
        <span aria-hidden className={`${box} font-mono text-caption text-text-tertiary`}>
          ·
        </span>
      );
  }
}

/** 行内附注：探测给时长分辨率帧率，运行中写「转写中」，超时写明，转写没音轨时说一声 */
function noteFor(step: EvidenceStepRecord, state: EvidenceState): string | undefined {
  if (step.status === "timeout") return "超过 10 分钟";
  if (step.status === "running") {
    // 后端挂的运行中附注优先，如转写前拉起服务时的「正在启动 WhisperX 服务」
    if (isRecord(step.detail) && typeof step.detail.note === "string") return step.detail.note;
    return `${EVIDENCE_LABELS[step.step].replace(/（.*）/, "")}中`;
  }
  if (step.status !== "done") return undefined;
  if (step.step === "probe" && state.probe) return describeProbe(state.probe);
  if (step.step === "transcribe" && isRecord(step.detail) && typeof step.detail.note === "string") {
    return step.detail.note;
  }
  return undefined;
}

function elapsedOf(step: EvidenceStepRecord, now: number): string {
  if (step.durationMs !== undefined) return formatElapsed(step.durationMs);
  if (step.status === "running" && step.startedAt) {
    return formatElapsed(now - new Date(step.startedAt).getTime());
  }
  return "—";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 有步骤在跑时每秒走一次，让耗时列实时跳；没在跑就不开定时器。
 * 刚开跑的第一秒 now 可能落后于 startedAt，elapsed 会被 formatElapsed 夹到 0:00
 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
