import type { ReactNode } from "react";
import type { Tone } from "../../lib/agent-timeline.js";

const BORDER: Record<Exclude<Tone, null>, string> = {
  danger: "border-danger",
  warning: "border-warning",
};

/**
 * 左竖线块（Design-Brief §A.2）：错误红、被宿主拦截琥珀。没有语气时不画线也不缩进，
 * 免得正常的行和带线的行左边对不齐——带线的行用负外边距把线挂到左侧留白里。
 */
export function ToneBlock({ tone, className = "", children }: { tone: Tone; className?: string; children: ReactNode }) {
  return (
    <div
      data-tone={tone ?? undefined}
      className={[tone ? `-ml-2.5 border-l-2 pl-2 ${BORDER[tone]}` : "", className].join(" ")}
    >
      {children}
    </div>
  );
}
