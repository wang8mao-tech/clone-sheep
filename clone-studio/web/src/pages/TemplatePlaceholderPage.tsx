import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { archiveApi, archiveKeys } from "../lib/archive.js";
import { isGone } from "../lib/api.js";
import { Button } from "../components/ui/Button.js";

/**
 * 模板页占位。
 *
 * 真正的模板页框架（页头 + 步骤条 CMP-001 + 步骤路由）是 Task 3.4 的交付。
 * 这里只保证 FLOW-004 的「点模板进流水线页」这一跳有地方可落、侧栏选中态成立，
 * 顺便把模板确实存在这件事验掉——删掉的模板留在地址栏里时要看得出来。
 */
export function TemplatePlaceholderPage() {
  const { templateId } = useParams();

  const template = useQuery({
    queryKey: archiveKeys.template(templateId ?? ""),
    queryFn: () => archiveApi.template(templateId as string),
    enabled: Boolean(templateId),
    retry: false,
  });

  return (
    <div className="flex flex-1 flex-col gap-5 px-6 py-5">
      {template.isError ? (
        // 只有 404 才是真没了；超时和后端挂掉要说实话，并给一条回得去的路
        <div className="flex flex-col items-start gap-3">
          <p className="text-[13px] text-text-secondary">
            {isGone(template.error) ? "这个模板已经不存在了。" : "读不到这个模板。"}
          </p>
          {isGone(template.error) ? null : (
            <>
              <pre className="max-h-40 w-[420px] overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-caption whitespace-pre-wrap text-text-secondary">
                {template.error instanceof Error ? template.error.message : String(template.error)}
              </pre>
              <Button variant="secondary" onClick={() => void template.refetch()} loading={template.isFetching}>
                重试
              </Button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-caption text-text-secondary">{template.data?.client.name ?? "　"}</p>
            <h1 className="text-heading-lg">{template.data?.name ?? "　"}</h1>
          </div>
          <div className="rounded-md border border-dashed border-border p-6">
            <p className="text-[13px] text-text-secondary">模板页在 Task 3.4 接通：页头、五步步骤条与各步工作区。</p>
          </div>
        </>
      )}
    </div>
  );
}
