import { useEffect, useRef } from "react";
import type { AssetView } from "../../lib/variant-review.js";
import { Button } from "../ui/Button.js";

/**
 * 看大图（CMP-005）：原生 <dialog>，焦点陷阱与 Esc 关闭交给浏览器。§6.1 说弹窗只用于危险确认与成片播放，
 * 但 CMP-005 要求「看大图」，这里按组件规格做成只放一张图的弹层
 */
export function AssetLightbox({ asset, onClose }: { asset: AssetView | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const name = asset ? (asset.label ?? asset.file ?? "素材") : "";
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (asset && !el.open) el.showModal();
    if (!asset && el.open) el.close();
  }, [asset]);
  return (
    <dialog
      ref={ref}
      aria-label={`大图：${name}`}
      onClose={onClose}
      className="max-h-[90vh] max-w-[90vw] rounded-md border border-border bg-bg p-3 backdrop:bg-black/60"
    >
      {asset?.imageUrl ? (
        <img src={asset.imageUrl} alt={name} className="max-h-[80vh] max-w-[85vw] object-contain" />
      ) : null}
      <div className="mt-2 flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </div>
    </dialog>
  );
}
