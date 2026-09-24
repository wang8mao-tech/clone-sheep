/**
 * ④ 变体「Agent 模型」下拉的过渡清单（SCREEN-006）。模型档案（REQ-010、CMP-010）在 Phase 10 落地，
 * 那时换成档案列表；在那之前只能在本机订阅下选模型 id，不改凭据与 base_url。
 *
 * 不可选的项仍列出来并写明原因（CMP-010「不满足当前任务要求的项置灰并附原因」）：Haiku 在 Phase 7 真机里
 * 两次编出不存在的 svml 导入，写不出能过 check 的稿子。
 */

export interface AgentModelOption {
  /** null = 不指定，用订阅的默认模型 */
  id: string | null;
  label: string;
  /** 不能选时的原因 */
  disabledReason: string | null;
}

export const AGENT_MODELS: readonly AgentModelOption[] = [
  { id: null, label: "订阅默认模型", disabledReason: null },
  { id: "claude-sonnet-5", label: "Sonnet 5", disabledReason: null },
  { id: "claude-opus-5-5", label: "Opus 5.5", disabledReason: null },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    disabledReason: "写不出能过 hypit check 的稿子（Phase 7 真机两次失败）",
  },
];

/** 提交时的模型 id 是否可用：不在清单里、或清单里标了不可选的，都不行 */
export function usableModel(id: string | null): boolean {
  const option = AGENT_MODELS.find((m) => m.id === id);
  return option !== undefined && option.disabledReason === null;
}
