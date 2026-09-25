import { useParams } from "react-router";
import { isStepKey } from "../../lib/steps.js";
import { CloneStep } from "./CloneStep.js";
import { OutputsStep } from "./OutputsStep.js";
import { ReferenceStep } from "./ReferenceStep.js";
import { ReviewStep } from "./ReviewStep.js";
import { VariantsStep } from "./VariantsStep.js";

/**
 * 步骤工作区：①参考（Phase 4）、②复刻（Phase 6）、③验货（Phase 7）、④变体（Phase 8）、⑤成片（Phase 9）。
 */
export function StepWorkspace() {
  const { step } = useParams();
  // 非法步骤到不了这里：TemplateLayout 会先把人重定向走。
  // 这里仍然守一道，免得将来有人绕开布局直接挂这个组件
  if (!isStepKey(step)) return null;
  if (step === "reference") return <ReferenceStep />;
  if (step === "clone") return <CloneStep />;
  if (step === "review") return <ReviewStep />;
  if (step === "variants") return <VariantsStep />;
  return <OutputsStep />;
}
