import { useId, useState } from "react";
import { ExternalLink, ImageOff, Maximize2, Upload } from "lucide-react";
import { checkImage, IMAGE_EXTENSIONS, type AssetView } from "../../lib/variant-review.js";
import { Badge } from "../ui/Badge.js";

interface Props {
  asset: AssetView;
  /** 素材待审之外不能换（按钮不出） */
  editable: boolean;
  busy: boolean;
  error: string | null;
  onReplace: (file: File) => void;
  onZoom: () => void;
}

/**
 * CMP-005 素材审核卡：缩略图 + 条目名 + 来源域名链接；悬停出「替换」「看大图」；
 * 角标：无来源（黄）、已替换（强调色）、缺口（红虚线占位 + 上传）。来源链接只给 http / https（后端已筛）
 */
export function AssetCard({ asset, editable, busy, error, onReplace, onZoom }: Props) {
  const inputId = useId();
  const [localError, setLocalError] = useState<string | null>(null);
  const name = asset.label ?? asset.file ?? "素材";
  const noSource = !asset.sourceUrl && !asset.replaced && !asset.gap;

  const pick = (file: File | undefined): void => {
    if (!file) return;
    const problem = checkImage(file);
    setLocalError(problem ?? null);
    if (!problem) onReplace(file);
  };

  return (
    <figure
      aria-label={`素材 ${name}`}
      className={[
        "group relative flex flex-col overflow-hidden rounded-md border bg-surface",
        asset.gap ? "border-dashed border-danger" : "border-border",
      ].join(" ")}
    >
      <div className="relative aspect-square bg-bg">
        {asset.gap ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-danger">
            <ImageOff aria-hidden className="size-6" />
            <span className="text-caption">缺口：Agent 没找到能用的图</span>
          </div>
        ) : asset.imageUrl ? (
          <img src={asset.imageUrl} alt={name} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center text-caption text-text-tertiary">没有图片文件</div>
        )}
        <div className="absolute top-1.5 left-1.5 flex gap-1">
          {asset.gap ? <Badge tone="danger">缺口</Badge> : null}
          {asset.replaced ? <Badge tone="primary">已替换</Badge> : null}
          {noSource ? <Badge tone="warning">无来源</Badge> : null}
        </div>
        {/* 没有能做的（缺口且不在素材待审）就不画这条，免得空着一条黑边 */}
        {editable || (asset.imageUrl && !asset.gap) ? (
          <div
            className={[
              "absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-bg/80 p-1.5 transition-opacity",
              asset.gap ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
            ].join(" ")}
          >
            {asset.imageUrl && !asset.gap ? (
              <button
                type="button"
                aria-label={`看大图 ${name}`}
                onClick={onZoom}
                className="inline-flex h-7 items-center gap-1 rounded px-2 text-caption text-text hover:bg-surface-raised"
              >
                <Maximize2 aria-hidden className="size-3.5" />
                看大图
              </button>
            ) : null}
            {editable ? (
              <>
                {/* 真正拿焦点的是文件输入（视觉隐藏）：放在标签前面，标签用 peer-focus-visible 画焦点环（8.4 审查 S2-M1） */}
                <input
                  id={inputId}
                  type="file"
                  accept={IMAGE_EXTENSIONS.join(",")}
                  aria-label={`${asset.gap ? "上传" : "替换"} ${name}`}
                  className="peer sr-only"
                  disabled={busy}
                  onChange={(e) => {
                    pick(e.currentTarget.files?.[0]);
                    e.currentTarget.value = "";
                  }}
                />
                <label
                  htmlFor={inputId}
                  // 同 Button：禁用时不吞指针事件，悬停看得到原因（输入框已 disabled，点了也不会选文件）
                  title={busy ? "正在替换这张图，换完再操作" : undefined}
                  className={[
                    "inline-flex h-7 items-center gap-1 rounded px-2 text-caption",
                    "peer-focus-visible:ring-2 peer-focus-visible:ring-primary",
                    asset.gap ? "text-danger" : "text-text",
                    busy ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-surface-raised",
                  ].join(" ")}
                >
                  <Upload aria-hidden className="size-3.5" />
                  {busy ? "替换中…" : asset.gap ? "上传" : "替换"}
                </label>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <figcaption className="flex flex-col gap-0.5 px-2 py-1.5">
        <span className="truncate text-[13px] text-text">{name}</span>
        {asset.sourceUrl ? (
          <a
            href={asset.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 truncate text-caption text-text-secondary hover:text-primary"
          >
            {asset.sourceHost ?? asset.sourceUrl}
            <ExternalLink aria-hidden className="size-3" />
          </a>
        ) : (
          <span className="text-caption text-text-tertiary">{asset.replaced ? "你上传的图" : "没有来源页"}</span>
        )}
        {(localError ?? error) ? (
          <span role="alert" className="text-caption text-danger">
            {localError ?? error}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
