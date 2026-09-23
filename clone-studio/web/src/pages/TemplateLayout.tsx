import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useParams } from "react-router";
import { useArchiveActions } from "../app/useArchiveActions.js";
import { Badge } from "../components/ui/Badge.js";
import { QueryErrorState } from "../components/ui/QueryErrorState.js";
import { InlineNameEditor } from "../components/ui/InlineNameEditor.js";
import { Stepper } from "../components/Stepper.js";
import { BreakerBar } from "../components/BreakerBar.js";
import { archiveApi, archiveKeys } from "../lib/archive.js";
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
      <QueryErrorState
        error={detail.error}
        goneText="这个模板已经不存在了。"
        errorText="读不到这个模板。"
        retrying={detail.isFetching}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const template = detail.data;
  const steps = deriveSteps({
    status: template?.status ?? "importing",
    evidenceStatus: template?.evidenceStatus ?? "idle",
  });
  const hrefFor = (key: StepKey): string => `/clients/${clientId}/templates/${templateId}/${key}`;

  // 数据还没回来时别急着重定向：那会按一份猜出来的步骤表把人送错地方
  const fallback = defaultStep(steps);
  if (template) {
    const target = steps.find((s) => s.key === step);
    const needsRedirect = !isStepKey(step) || !target?.enterable;
    // fallback 与当前步相同就别跳了——那是一次自指的重定向，页面会永远停在
    // <Navigate> 上，整页渲染不出东西。一步都进不去时也同理：宁可把步骤条
    // 画出来让人看见「全锁着」，也不要白屏
    if (needsRedirect && fallback && fallback !== step) {
      return <Navigate to={hrefFor(fallback)} replace />;
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
            <h1 className="min-w-0 text-[18px] font-semibold">
              {/* px-1 -mx-1：视觉位置不变但命中区变大，hover 的色块也不再
                  紧贴字形。没有内边距的话那块高亮看着不像能点的东西 */}
              <button
                type="button"
                title="点一下改名"
                disabled={!template}
                onClick={() => template && beginEdit({ kind: "template", id: templateId, name: template.name })}
                className="-mx-1 max-w-[calc(100%+0.5rem)] truncate rounded-sm px-1 hover:bg-surface-raised"
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

      <Stepper
        steps={steps}
        current={isStepKey(step) ? step : (fallback ?? "reference")}
        // Q7：数据没到时这份步骤表是按缺省值猜的，先别让人点——
        // 点了会跳去一个马上要被重定向走的步骤
        loading={!template}
        hrefFor={hrefFor}
      />

      {/* CMP-009：任务熔断 / 中断 / 失败 / 取消后给「继续」「重跑」，在步骤条下方、工作区上方 */}
      <BreakerBar />

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
        {/* 不往 Outlet 里塞 context：现在没有任何消费方，而匿名对象字面量
            传下去的类型是 unknown，接的人得自己 cast，很容易 cast 错。
            Phase 4 真要用时再加一个带类型的 useTemplateContext() */}
        <Outlet />
      </div>
    </>
  );
}
