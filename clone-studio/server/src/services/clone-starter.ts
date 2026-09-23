/**
 * 证据准备做完就该自动开始复刻（FLOW-002 步骤 3），但证据流水线不该为此把 Agent SDK 拉进
 * 自己的依赖图。这里放一个注册点：启动时由复刻编排（clone.ts）注册真的启动函数，证据流水线只
 * 认这个接口，测试里换成假的。和 agent-stopper.ts 同一个做法。
 *
 * 触发点只有「这一次导入真的做完了」这一刻，所以库里已有的模板永远不会被补跑。
 * 没注册时是空实现：脚本、迁移工具跑证据准备不会顺带起 Agent。
 */
export type CloneStarter = (templateId: string) => void;

let starter: CloneStarter | undefined;

export function setCloneStarter(next: CloneStarter | undefined): void {
  starter = next;
}

/** 证据准备刚做完时调用。启动失败只影响复刻，不能反过来让证据流水线判失败 */
export function requestClone(templateId: string): void {
  try {
    starter?.(templateId);
  } catch {
    // 起不来的原因由复刻编排自己记；证据已经做完，这一步不回滚
  }
}
