import { useState } from "react";
import { Button } from "../../components/ui/Button.js";
import { Textarea } from "../../components/ui/Input.js";
import { REWORK_NOTE_MAX } from "../../lib/review.js";

/**
 * 「打回」（SCREEN-005 底部左侧的次按钮）：点开展开意见框，写 1-2000 字（去掉首尾空白算），提交后作为
 * 「打回意见 #n」一轮 resume 原会话（REQ-004）。意见是说给原会话听的，所以提交前把轮次写在按钮上。
 */
export function ReworkPanel({
  round,
  blocked,
  busy,
  onSubmit,
}: {
  round: number;
  /** 不能打回的原因；有值时按钮禁用并在提示里说明 */
  blocked: string | undefined;
  busy: boolean;
  onSubmit: (note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const length = note.trim().length;
  const tooLong = length > REWORK_NOTE_MAX;

  if (!open) {
    return (
      <Button
        variant="secondary"
        disabled={blocked !== undefined}
        disabledReason={blocked}
        onClick={() => setOpen(true)}
      >
        打回
      </Button>
    );
  }
  return (
    <div className="flex w-full max-w-[560px] flex-col gap-2">
      <Textarea
        label={`打回意见 #${round}`}
        rows={4}
        value={note}
        autoFocus
        onChange={(e) => setNote(e.currentTarget.value)}
        placeholder="写清楚哪里不像、要怎么改，例如：主持人太小，放大到画面一半；第 3 秒转场要硬切"
        hint={`${length} / ${REWORK_NOTE_MAX}`}
        error={tooLong ? `超过 ${REWORK_NOTE_MAX} 字了（${length}）` : undefined}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          loading={busy}
          disabled={blocked !== undefined || length === 0 || tooLong}
          disabledReason={blocked ?? (length === 0 ? "先写意见" : tooLong ? "意见太长" : undefined)}
          onClick={() => onSubmit(note)}
        >
          提交打回
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          收起
        </Button>
      </div>
    </div>
  );
}
