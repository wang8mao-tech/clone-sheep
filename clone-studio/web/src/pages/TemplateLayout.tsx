import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useParams } from "react-router";
import { useArchiveActions } from "../app/useArchiveActions.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { InlineNameEditor } from "../components/ui/InlineNameEditor.js";
import { Stepper } from "../components/Stepper.js";
import { archiveApi, archiveKeys } from "../lib/archive.js";
import { isGone } from "../lib/api.js";
import { formatUsd } from "../lib/format.js";
import { defaultStep, deriveSteps, isStepKey, type StepKey } from "../lib/steps.js";

/**
 * 模板页框架（SCREEN-003 至 SCREEN-008 共用）。
 *
 * 页头 + 五步步骤条 + 步骤工作区，只换步骤条下方那块（Design-Brief §3）。
 * 步骤写在地址里，刷新才能停在原处；直接敲一个还没解锁的步骤会被送回
 * 当前该在的那一步，而不是给一个空白页。
 */
export function TemplateLayout() {
  const { clientId = "", templateId = "", step } = useParams();
  const actions = useArchiveActions();
  const { editing, editError, beginEdit, closeEditor, clearEditError, rename } = actions;

  const detail = useQuery({
    queryKey: archiveKeys.template(templateId),
    queryFn: () => archiveApi.template(templateId),
    enabled: Boolean(templateId),
    retry: false,
  });

  if (detail.isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-[13px] text-text-secondary">
            {isGone(detail.error) ? "这个模板已经不存在了。" : "读不到这个模板。"}
          </p>
          {isGone(detail.error) ? null : (
            <>
              <pre className="max-h-40 w-[420px] overflow-auto rounded-md border border-border bg-surface p-3 text-left font-mono text-caption whitespace-pre-wrap text-text-secondary">
                {detail.error instanceof Error ? detail.error.message : String(detail.error)}
              </pre>
              <Button variant="secondary" onClick={() => void detail.refetch()} loading={detail.isFetching}>
                重试
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  const template = detail.data;
  const steps = deriveSteps({
    status: template?.status ?? "importing",
    hasSource: template?.hasSource ?? false,
    outputs: template?.stats.outputs ?? 0,
  });
  const hrefFor = (key: StepKey): string => `/clients/${clientId}/templates/${templateId}/${key}`;

  // 数据还没回来时别急着重定向：那会按一份猜出来的步骤表把人送错地方
  if (template) {
    const target = steps.find((s) => s.key === step);
    if (!isStepKey(step) || !target?.enterable) {
      return <Navigate to={hrefFor(defaultStep(steps))} replace />;
    }
  }

  const editingName = editing?.kind === "template" && editing.id === templateId;

  return (
    <>
      <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[13px] text-text-secondary">{template?.client.name ?? "　"}</span>
          <span aria-hidden className="shrink-0 text-text-tertiary">
            /
          </span>
          {editingName ? (
            <div className="w-64">
              <InlineNameEditor
                initialValue={editing.name}
                placeholder="模板名"
                busy={rename.isPending}
                error={editError}
                indentClass="pl-0"
                onDirty={clearEditError}
                onCommit={(name) => rename.mutate({ kind: "template", id: templateId, name })}
                onCancel={closeEditor}
              />
            </div>
          ) : (
            // 模板名就是这一页的标题，语义上得是 h1；同时它可以就地改名，
            // 所以标题里套一个按钮，而不是拿按钮顶替标题
            <h1 className="min-w-0 truncate text-[18px] font-semibold">
              <button
                type="button"
                title="点一下改名"
                disabled={!template}
                onClick={() => template && beginEdit({ kind: "template", id: templateId, name: template.name })}
                className="max-w-full truncate rounded-sm hover:bg-surface-raised"
              >
                {template?.name ?? "　"}
              </button>
            </h1>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-caption text-text-secondary">模板累计</span>
          <span className="font-mono text-[13px]">{formatUsd(template?.stats.totalCostUsd ?? 0)}</span>
          {/* REQ-009 MUST：花费一律标「估」 */}
          <Badge tone="warning" title="花费均为估算，以 Provider 侧为准">
            估
          </Badge>
        </div>
      </div>

      <Stepper steps={steps} current={isStepKey(step) ? step : "reference"} hrefFor={hrefFor} />

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
        <Outlet context={{ template }} />
      </div>
    </>
  );
}
