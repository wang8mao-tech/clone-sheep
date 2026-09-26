import { Button } from "./Button.js";
import { isGone } from "../../lib/api.js";

interface Props {
  error: unknown;
  /** 404 时说什么，如「这个客户已经不存在了。」 */
  goneText: string;
  /** 其余错误说什么，如「读不到这个客户。」 */
  errorText: string;
  onRetry: () => void;
  retrying?: boolean;
}

/**
 * 查询失败时的统一错误态。
 *
 * 只有 404 才说「已经不存在」——5 秒超时抛的是 `ApiError("后端未响应", 0)`，
 * 不分流的话后端一卡就会被界面说成"对象被删了"，还不给回头路。
 * 非 404 一律贴后端原文并给重试。
 *
 * 抽出来是因为首页、客户页、模板页原本各抄了一份二十行，连
 * `w-[420px]`（上一轮真机发现 `max-w-lg` 在这套配置里解析成 16px 之后改的
 * 显式值）都要复制三遍，改一处忘两处是迟早的事。
 */
export function QueryErrorState({ error, goneText, errorText, onRetry, retrying = false }: Props) {
  const gone = isGone(error);
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="text-[13px] text-text-secondary">{gone ? goneText : errorText}</p>
        {gone ? null : (
          <>
            <pre className="max-h-40 w-[420px] overflow-auto rounded-md border border-border bg-surface p-3 text-left font-mono text-caption whitespace-pre-wrap text-text-secondary">
              {error instanceof Error ? error.message : String(error)}
            </pre>
            <Button variant="secondary" onClick={onRetry} loading={retrying}>
              重试
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
