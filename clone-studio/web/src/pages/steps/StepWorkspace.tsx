import { useParams } from "react-router";
import { isStepKey, type StepKey } from "../../lib/steps.js";

/** 每一步的工作区各自在哪个 Phase 落地，写清楚免得看的人以为忘了做 */
const OWNER: Record<StepKey, string> = {
  reference: "Phase 4：参考视频导入与证据准备",
  clone: "Phase 6：复刻、估价闸门与出片",
  review: "Phase 7：模板验货",
  variants: "Phase 8：批量变体与素材审核",
  outputs: "Phase 9：成片库、下载与花费明细",
};

const TITLE: Record<StepKey, string> = {
  reference: "① 参考",
  clone: "② 复刻",
  review: "③ 验货",
  variants: "④ 变体",
  outputs: "⑤ 成片",
};

/**
 * 步骤工作区占位。
 *
 * Task 3.4 只交付模板页框架（页头 + 步骤条 + 步骤路由），五块工作区分别属于
 * 后面的 Phase。这里如实标出归属，而不是放一句含糊的「敬请期待」。
 */
export function StepWorkspace() {
  const { step } = useParams();
  // 非法步骤到不了这里：TemplateLayout 会先把人重定向走。
  // 这里仍然守一道，免得将来有人绕开布局直接挂这个组件
  if (!isStepKey(step)) return null;

  return (
    <section aria-label={`${TITLE[step]} 工作区`} className="rounded-md border border-dashed border-border p-6">
      <h2 className="text-[13px] font-semibold text-text">{TITLE[step]}</h2>
      <p className="mt-1 text-[13px] text-text-secondary">这一步的工作区在 {OWNER[step]} 落地。</p>
    </section>
  );
}
