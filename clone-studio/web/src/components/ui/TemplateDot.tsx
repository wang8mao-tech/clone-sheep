import type { TemplateStatus } from "../../lib/archive.js";

/**
 * 模板状态点（SCREEN-001 侧栏、SCREEN-002 客户页共用）。
 *
 * 形状和颜色一起区分，不能只靠颜色（Design-Brief 8.2）。尤其是「复刻中」和
 * 「待验货」都是主色：只拿 animate-pulse 区分的话，prefers-reduced-motion 下
 * 动画被压到 0.01ms 瞬间跑完，两个状态会渲染得一模一样，所以「待验货」用空心圈。
 * 点本身 aria-hidden，状态靠随行的 sr-only 文字读出来。
 */
const SPEC: Record<TemplateStatus, { dot: string; label: string }> = {
  importing: { dot: "bg-text-tertiary", label: "导入中" },
  cloning: { dot: "bg-primary animate-pulse", label: "复刻中" },
  awaiting_review: { dot: "border-2 border-primary bg-transparent", label: "待验货" },
  approved: { dot: "bg-success", label: "已验货" },
  failed: { dot: "bg-danger", label: "失败" },
};

export function TemplateDot({ status, ringed = false }: { status: TemplateStatus; ringed?: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className={["inline-block size-2 shrink-0 rounded-full", SPEC[status].dot, ringed ? "dot-ring" : ""].join(" ")}
      />
      <span className="sr-only">{SPEC[status].label}</span>
    </>
  );
}
