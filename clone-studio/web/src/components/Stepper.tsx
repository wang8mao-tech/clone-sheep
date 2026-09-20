import { Fragment } from "react";
import { Check } from "lucide-react";
import { useNavigate } from "react-router";
import type { Step, StepKey, StepState } from "../lib/steps.js";

interface Props {
  steps: readonly Step[];
  current: StepKey;
  /** 点已解锁的步骤跳过去；未解锁的不可点 */
  hrefFor: (key: StepKey) => string;
  /**
   * 模板数据还没到。此时步骤表是按缺省值猜出来的（一个已验货的模板会先被
   * 画成「①进行中 + 后面四个 ·」），这一帧的信息是错的，所以整体不可点。
   */
  loading?: boolean;
}

/** 七态里除「当前」之外的六态各自的说法，给屏幕阅读器用 */
const STATE_LABEL: Record<StepState, string> = {
  locked: "未解锁",
  available: "可进入",
  running: "进行中",
  attention: "需处理",
  done: "已完成",
  failed: "失败",
};

/**
 * CMP-001 流水线步骤条。
 *
 * 「当前」与其余六态是两个维度：一个步骤可以既是「已完成」又是「当前」。
 * 所以当前态只管下划线与文字份量，圆圈里的内容由 state 决定。
 *
 * 尺寸取自设计稿实测（DEV-PLAN Phase 3）：高 44、padding 0 24、步间距 12、
 * 每步 padding 0 4、底边 2px、序号圆 18px/1px 描边/mono 11px、
 * 步名 13px、步与步之间一根 28×1px 连接线。
 *
 * 未解锁显「·」而不是 Design-Brief CMP-001 写的锁图标——设计稿画的是点，
 * 按「有设计稿时 UI 以设计稿为准」走。状态本身靠 sr-only 文字读出来，
 * 不只依赖形状与颜色（Design-Brief 8.2）。
 */
export function Stepper({ steps, current, hrefFor, loading = false }: Props) {
  const navigate = useNavigate();

  return (
    <nav
      aria-label="流水线步骤"
      aria-busy={loading || undefined}
      className={`flex h-11 shrink-0 items-center gap-3 border-b border-border px-6 ${loading ? "opacity-40" : ""}`}
    >
      {steps.map((step, i) => {
        const isCurrent = step.key === current;
        return (
          <Fragment key={step.key}>
            {i > 0 ? <span aria-hidden className="h-px w-7 shrink-0 bg-border" /> : null}
            <button
              type="button"
              disabled={loading || !step.enterable}
              aria-current={isCurrent ? "step" : undefined}
              title={loading ? "读取中" : step.enterable ? undefined : "还没解锁"}
              onClick={() => void navigate(hrefFor(step.key))}
              className={[
                "flex h-full items-center gap-2 border-b-2 px-1 transition-colors",
                isCurrent ? "border-primary" : "border-transparent",
                step.enterable ? "cursor-pointer" : "cursor-not-allowed",
              ].join(" ")}
            >
              <StepMark step={step} isCurrent={isCurrent} />
              <span
                className={[
                  "text-[13px] whitespace-nowrap",
                  isCurrent ? "font-semibold text-text" : "font-normal text-text-tertiary",
                ].join(" ")}
              >
                {step.label}
              </span>
              <span className="sr-only">
                {STATE_LABEL[step.state]}
                {isCurrent ? "，当前步骤" : ""}
              </span>
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

/** 序号圆：18px、1px 描边、mono 11px。里面放什么由状态决定 */
function StepMark({ step, isCurrent }: { step: Step; isCurrent: boolean }) {
  const ring =
    step.state === "failed"
      ? "border-danger text-danger"
      : step.state === "attention"
        ? "border-warning text-warning"
        : step.state === "done"
          ? "border-success text-success"
          : step.state === "running"
            ? "border-primary text-primary animate-pulse"
            : isCurrent
              ? "border-primary text-primary"
              : "border-border text-text-tertiary";

  return (
    <span
      aria-hidden
      className={`flex size-[18px] shrink-0 items-center justify-center rounded-full border font-mono text-[11px] ${ring}`}
    >
      {step.state === "done" ? (
        <Check className="size-3" />
      ) : step.state === "failed" || step.state === "attention" ? (
        <span className={`size-1.5 rounded-full ${step.state === "failed" ? "bg-danger" : "bg-warning"}`} />
      ) : step.state === "locked" ? (
        "·"
      ) : (
        step.index
      )}
    </span>
  );
}
