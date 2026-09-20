/**
 * 证据流水线的共享类型与错误。
 *
 * 单独成文件是为了解开循环 import：编排（evidence.ts）要调用步骤实现
 * （evidence-steps.ts），而步骤实现又要用编排里的错误类和入参类型。ESM 靠
 * 延迟求值能侥幸跑起来，但那会让 routes/errors.ts 为了一个错误类把整条编排
 * 拖进依赖图，也让步骤实现没法单独测。
 */

export type EvidenceSource = { kind: "file"; path: string } | { kind: "url"; url: string };

export interface StartArgs {
  templateId: string;
  source: EvidenceSource;
  language: string;
  note?: string;
}

export class EvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EvidenceError";
  }
}
