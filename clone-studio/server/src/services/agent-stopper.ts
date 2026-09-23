/**
 * 删除流程要先停 Agent 任务（AC-002：确认后 Agent 进程已结束再删目录），但 deletion 不该
 * 为此把整个 Agent SDK 拉进自己的依赖图。这里放一个注册点：启动时由 agent-service 注册真的
 * 停止函数，删除流程只认这个接口，测试里换成假的。
 *
 * 没注册时是空实现：Agent 还没接进来的场合（脚本、迁移工具）照样能删，进程那一层还有
 * procs.killBySubject 兜底。
 */
export type AgentStopper = (owners: ReadonlyArray<{ kind: "template" | "production"; id: string }>) => Promise<number>;

let stopper: AgentStopper | undefined;

export function setAgentStopper(next: AgentStopper | undefined): void {
  stopper = next;
}

/** 停掉这些对象上没结束的 Agent 任务，等会话真的结束；返回停了几个 */
export async function stopAgentsFor(
  owners: ReadonlyArray<{ kind: "template" | "production"; id: string }>,
): Promise<number> {
  if (!stopper || owners.length === 0) return 0;
  return stopper(owners);
}
