import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { Film, Plus } from "lucide-react";
import { useArchiveActions } from "../app/useArchiveActions.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { ConfirmDangerDialog } from "../components/ui/ConfirmDangerDialog.js";
import { InlineNameEditor } from "../components/ui/InlineNameEditor.js";
import { QueryErrorState } from "../components/ui/QueryErrorState.js";
import { RowMenu } from "../components/ui/RowMenu.js";
import { TemplateDot } from "../components/ui/TemplateDot.js";
import { TaskRow } from "../components/TaskRow.js";
import { archiveApi, archiveKeys, impactLines } from "../lib/archive.js";
import { formatActivityTime, formatUsd } from "../lib/format.js";

/**
 * SCREEN-002 客户页：模板的紧凑行列表（CMP-002）。
 *
 * 设计稿只画了 7 屏，没有这一屏，所以按 Design-Brief SCREEN-002 的字面列举实现：
 * 状态点、模板名、参考视频缩略帧（小）、成片数、累计花费、最近活动时间。
 * 缩略帧要等 Phase 4 抽帧才有，这里先留位并标明没有。
 */
export function ClientPage() {
  const { clientId = "" } = useParams();
  const actions = useArchiveActions();
  const { editing, editError, pending, beginEdit, closeEditor, clearEditError, cancelDelete } = actions;

  const detail = useQuery({
    queryKey: archiveKeys.client(clientId),
    queryFn: () => archiveApi.client(clientId),
    enabled: Boolean(clientId),
    retry: false,
  });

  if (detail.isError) {
    return (
      <QueryErrorState
        error={detail.error}
        goneText="这个客户已经不存在了。"
        errorText="读不到这个客户。"
        retrying={detail.isFetching}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const templates = detail.data?.templates ?? [];
  const addingTemplate = editing?.kind === "new-template" && editing.clientId === clientId;

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
      <div className="flex h-8 items-center justify-between gap-3">
        <h1 className="truncate text-heading-lg">{detail.data?.client.name ?? "　"}</h1>
        {/* 空状态自己会给一个「新建模板」，页头这个就收起来——
            两个可访问名一模一样的按钮，读屏用户分不清点哪个 */}
        {templates.length === 0 && !detail.isLoading ? null : (
          <Button
            variant="primary"
            icon={<Plus aria-hidden className="size-4" />}
            disabled={actions.busy || !detail.data}
            onClick={() => beginEdit({ kind: "new-template", clientId })}
          >
            新建模板
          </Button>
        )}
      </div>

      {addingTemplate ? (
        <div className="w-80">
          <InlineNameEditor
            placeholder="模板名"
            busy={actions.createTemplate.isPending}
            error={editError}
            indentClass="pl-0"
            onDirty={clearEditError}
            onCommit={(name) => actions.createTemplate.mutate({ clientId, name })}
            onCancel={closeEditor}
          />
        </div>
      ) : null}

      {detail.isLoading ? (
        <ul className="flex flex-col gap-1" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="h-9 animate-pulse rounded-md bg-surface-raised" />
          ))}
        </ul>
      ) : templates.length === 0 ? (
        !addingTemplate ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <p className="text-[13px] text-text-secondary">这个客户下还没有模板。建一个，再导入参考视频。</p>
              <Button
                variant="primary"
                icon={<Plus aria-hidden className="size-4" />}
                onClick={() => beginEdit({ kind: "new-template", clientId })}
              >
                新建模板
              </Button>
            </div>
          </div>
        ) : null
      ) : (
        <div className="rounded-md border border-border">
          <div className="flex h-8 items-center gap-3 border-b border-border px-3 text-caption text-text-tertiary">
            <span className="w-2 shrink-0" />
            <span className="w-8 shrink-0" />
            <span className="min-w-0 flex-1">模板</span>
            <span className="w-16 shrink-0 text-right">成片</span>
            <span className="w-24 shrink-0 text-right">累计花费</span>
            <span className="w-24 shrink-0 text-right">最近活动</span>
            <span className="w-5 shrink-0" />
          </div>
          <ul aria-label="模板列表" className="flex flex-col">
            {templates.map((tpl) =>
              editing?.kind === "template" && editing.id === tpl.id ? (
                <li key={tpl.id} className="border-b border-border/60 last:border-b-0">
                  <InlineNameEditor
                    initialValue={tpl.name}
                    placeholder="模板名"
                    busy={actions.rename.isPending}
                    error={editError}
                    onDirty={clearEditError}
                    onCommit={(name) => actions.rename.mutate({ kind: "template", id: tpl.id, name })}
                    onCancel={closeEditor}
                  />
                </li>
              ) : (
                <TaskRow
                  key={tpl.id}
                  href={`/clients/${clientId}/templates/${tpl.id}`}
                  openLabel={`打开模板 ${tpl.name}`}
                  lead={
                    <div className="flex items-center gap-3">
                      <TemplateDot status={tpl.status} />
                      {/* 参考视频缩略帧：Phase 4 抽帧后才有内容，现在只占位 */}
                      <span
                        title={tpl.hasSource ? "参考视频已导入，缩略帧在证据准备后生成" : "还没有参考视频"}
                        className="flex h-6 w-8 shrink-0 items-center justify-center rounded-sm border border-border bg-bg"
                      >
                        <Film
                          aria-hidden
                          className={`size-3 ${tpl.hasSource ? "text-text-secondary" : "text-text-tertiary/50"}`}
                        />
                      </span>
                    </div>
                  }
                  title={<span className="text-text">{tpl.name}</span>}
                  columns={[
                    { label: "成片", width: "4rem", numeric: true, content: tpl.stats.outputs },
                    {
                      label: "累计花费",
                      width: "6rem",
                      numeric: true,
                      content: (
                        // REQ-009 MUST：两类花费一律标"估"，不看 costIsEstimate 分支。
                        // Q-003 已定死 build 后也拿不到实际金额，不存在"不是估算"的花费
                        <span className="inline-flex items-center justify-end gap-1">
                          {formatUsd(tpl.stats.totalCostUsd)}
                          <Badge tone="warning" title="花费均为估算，以 Provider 侧为准">
                            估
                          </Badge>
                        </span>
                      ),
                    },
                    {
                      label: "最近活动",
                      width: "6rem",
                      numeric: true,
                      content: formatActivityTime(tpl.stats.lastActivityAt),
                    },
                  ]}
                  actions={
                    <RowMenu
                      label={`${tpl.name} 的操作`}
                      items={[
                        {
                          label: "重命名",
                          onSelect: () => beginEdit({ kind: "template", id: tpl.id, name: tpl.name }),
                        },
                        {
                          label: "删除",
                          tone: "danger",
                          onSelect: () => void actions.askDelete("template", tpl.id, tpl.name),
                        },
                      ]}
                    />
                  }
                />
              ),
            )}
          </ul>
        </div>
      )}

      <ConfirmDangerDialog
        open={pending !== null}
        title={`删除模板「${pending?.name ?? ""}」`}
        confirmName={pending?.name ?? ""}
        impacts={pending ? impactLines(pending.impact) : []}
        busy={actions.remove.isPending}
        onConfirm={() => {
          if (pending) actions.remove.mutate({ kind: pending.kind, id: pending.id });
        }}
        onCancel={cancelDelete}
      />
    </div>
  );
}
