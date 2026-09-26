import { Link } from "react-router";
import { TriangleAlert } from "lucide-react";
import type { CheckResult } from "./HealthRow.js";

/**
 * 任一 P0 体检未过时，主区顶部出琥珀横幅（DEV-PLAN Phase 2）。
 * 文案照设计稿："N 项环境体检未通过：<第一项现状>，导入与出片暂不可用"
 */
export function HealthBanner({ failures }: { failures: readonly CheckResult[] }) {
  if (failures.length === 0) return null;
  const first = failures[0];
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-6 py-2">
      <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
      <span className="flex-1 text-[13px] text-warning">
        {failures.length} 项环境体检未通过：{first ? `${first.name} ${first.detail}` : ""}，导入与出片暂不可用
      </span>
      {/* 颜色必须显式给：不给的话吃 @layer base 的 a{color:primary}，
          在琥珀横幅里渲染成一条主色绿，和周围的 text-warning 打架 */}
      <Link to="/settings" className="text-[13px] text-warning underline hover:text-warning/80">
        去设置
      </Link>
    </div>
  );
}
