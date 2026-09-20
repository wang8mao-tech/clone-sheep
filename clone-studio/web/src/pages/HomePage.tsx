import { Button } from "../components/ui/Button.js";

/**
 * SCREEN-002 首页空状态：居中一句话 + 一个主按钮，不放插画（Design-Brief 5.5）。
 * 新建客户的接口在 Phase 3 接上，这里先只画状态。
 */
export function HomePage() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <p className="text-[13px] text-text-secondary">还没有客户。建一个客户，再往里加参考视频。</p>
        <Button variant="primary" disabled disabledReason="先用左侧栏底部的「+ 新客户」，这个按钮在 Task 3.3 接通">
          新建客户
        </Button>
      </div>
    </div>
  );
}
