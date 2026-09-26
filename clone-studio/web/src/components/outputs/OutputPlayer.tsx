import { useEffect, useRef, useState } from "react";
import {
  deleteBlocked,
  downloadUrl,
  nextStepHint,
  retryable,
  stopText,
  videoUrl,
  type OutputView,
} from "../../lib/outputs.js";
import { Button } from "../ui/Button.js";
import { ConfirmDangerDialog } from "../ui/ConfirmDangerDialog.js";
import { PRIMARY_LINK_CLASS } from "../ui/link-styles.js";
import { CostBreakdown } from "./CostBreakdown.js";

interface Props {
  output: OutputView | null;
  deleting: boolean;
  /** 删除被后端拒的原文：挂在确认框里（框不关），改了再确认 */
  deleteError: string | null;
  retrying: boolean;
  /** 重试出片被拒的原文 */
  actionError: string | null;
  onDelete: () => void;
  onDeleteCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
}

/**
 * ⑤ 成片的居中弹层（SCREEN-008，§6.1 弹窗只用于危险确认与成片播放）：左边播放器（按比例自适应、不拉伸），
 * 右边花费明细 CMP-008；下载、删除（CMP-012 输入名称确认，§6.1「删除走 CMP-012」）。
 * 没出完的不放播放器：失败的写出片错误原文并给「重试出片」。服务端一定会拒的删除（流水线里的、失败的复刻片）不给点，写明原因
 */
export function OutputPlayer({
  output: o,
  deleting,
  deleteError,
  retrying,
  actionError,
  onDelete,
  onDeleteCancel,
  onRetry,
  onClose,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // 确认框记的是「为哪一条打开的」：换了一条（或删掉后关上）自然就不算开着，
  // 不然下一条一打开就弹出它的删除确认（9.2 第二轮审查 S1-A）
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const confirm = o !== null && confirmFor === o.id;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (o && !el.open) el.showModal();
    if (!o && el.open) el.close();
  }, [o]);
  // 停在哪一步、原文，由服务端按 ④ 的顺序算好（估价比出片新就说估价；9.2 第四轮审查 S1-H1 / S1-M1）
  const hint = o ? nextStepHint(o) : null;
  const blockedDelete = o ? deleteBlocked(o) : null;

  return (
    <dialog
      ref={ref}
      aria-label={o ? `成片：${o.name}` : "成片"}
      // 里面的删除确认也是 <dialog>：它关上时的 close 会沿 React 树冒上来，只认自己的
      onClose={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="elevation-overlay m-auto max-h-[90vh] w-[min(960px,92vw)] rounded-lg border border-border bg-surface p-0 text-text backdrop:bg-black/60"
    >
      {o ? (
        <div className="flex max-h-[90vh] flex-col">
          <header className="flex items-center gap-3 border-b border-border px-4 py-3">
            <h2 className="min-w-0 flex-1 truncate text-heading-md">{o.name}</h2>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </header>
          <div className="flex min-h-0 gap-4 overflow-auto p-4">
            <div className="flex min-w-0 flex-1 items-center justify-center rounded-md bg-black">
              {o.downloadable ? (
                <video
                  key={o.id}
                  src={videoUrl(o.id)}
                  controls
                  aria-label={`播放 ${o.name}`}
                  className="max-h-[70vh] max-w-full object-contain"
                />
              ) : (
                <div className="flex w-full max-w-[448px] flex-col gap-2 p-6 text-center">
                  <p className="text-[13px] text-text-secondary">
                    {o.status === "done" ? "成片文件不在了，没法播放。" : "这条还没有出好的片子。"}
                  </p>
                  {o.stop ? (
                    <pre className="max-h-[40vh] overflow-auto text-left font-mono text-caption whitespace-pre-wrap [overflow-wrap:anywhere] text-danger">
                      {stopText(o.stop)}
                    </pre>
                  ) : null}
                  {hint ? <p className="text-caption text-text-secondary">{hint}</p> : null}
                  {retryable(o) ? (
                    <Button variant="primary" className="self-center" loading={retrying} onClick={onRetry}>
                      重试出片
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
            <aside className="w-[360px] min-w-0 shrink-0">
              <CostBreakdown productionId={o.id} />
            </aside>
          </div>
          <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
            {actionError ? (
              <p role="alert" className="min-w-0 flex-1 text-caption text-danger">
                {actionError}
              </p>
            ) : (
              <span className="flex-1" />
            )}
            <Button
              variant="ghost"
              loading={deleting}
              disabled={blockedDelete !== null}
              disabledReason={blockedDelete ?? undefined}
              onClick={() => setConfirmFor(o.id)}
            >
              删除成片
            </Button>
            {o.downloadable ? (
              <a href={downloadUrl(o.id)} download className={PRIMARY_LINK_CLASS}>
                下载
              </a>
            ) : null}
          </footer>
          <ConfirmDangerDialog
            open={confirm}
            title={`删除成片「${o.name}」`}
            confirmName={o.name}
            impacts={[
              o.downloadable ? "删掉这条成片的视频文件与封面，删了不能恢复" : "这条成片从成片库里移除，删了不能恢复",
              // 还能重来的变体删了就一并作废（REQ-007）：级联影响写出来（CMP-012，9.2 第二轮审查 S1-C）
              ...(o.kind === "variant" && (o.status === "failed" || o.status === "interrupted")
                ? ["这条变体会一并作废，之后不能再重试出片或重跑"]
                : []),
              "它的花费照旧计入模板与客户的累计",
            ]}
            confirmLabel="删除成片"
            busy={deleting}
            {...(deleteError ? { error: deleteError } : {})}
            onConfirm={onDelete}
            onCancel={() => {
              setConfirmFor(null);
              onDeleteCancel();
            }}
          />
        </div>
      ) : null}
    </dialog>
  );
}
