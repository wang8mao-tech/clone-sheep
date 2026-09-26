import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { OutputCard } from "../../components/outputs/OutputCard.js";
import { OutputPlayer } from "../../components/outputs/OutputPlayer.js";
import { Button } from "../../components/ui/Button.js";
import { QueryErrorState } from "../../components/ui/QueryErrorState.js";
import { PRIMARY_LINK_CLASS } from "../../components/ui/link-styles.js";
import { useTemplateAgent } from "../../lib/agent-feed-context.js";
import { archiveKeys } from "../../lib/archive.js";
import { buildApi } from "../../lib/build.js";
import {
  matchesOutput,
  OUTPUT_FILTERS,
  outputApi,
  outputKeys,
  shouldPoll,
  zipUrl,
  type OutputFilter,
  type OutputView,
} from "../../lib/outputs.js";

/** 有渲染中 / 等出片的卡片时每 3 秒重拉：进度只在内存里，不推事件 */
const POLL_MS = 3_000;

/**
 * 列数按工作区宽度（容器查询）：Design-Brief SCREEN-008 与 §9——1280 下 6 列、抽屉展开降为 4 列、≥1600 8 列。
 * 抽屉开合改的是工作区宽度，不用另外传开合状态（9.2 审查 S1-1）
 */
const GRID = "grid grid-cols-4 gap-4 @min-[700px]:grid-cols-6 @min-[1200px]:grid-cols-8";

/** ⑤ 成片（SCREEN-008、REQ-007、REQ-009）：筛选 + 多选打包的工具条、竖屏封面网格、播放弹层 */
export function OutputsStep() {
  const { templateId = "" } = useParams();
  return (
    <section aria-label="⑤ 成片 工作区" className="@container flex flex-col gap-4">
      <OutputsBody key={templateId} templateId={templateId} />
    </section>
  );
}

function OutputsBody({ templateId }: { templateId: string }) {
  const qc = useQueryClient();
  const { feed } = useTemplateAgent();
  const list = useQuery({
    queryKey: outputKeys.list(templateId),
    queryFn: () => outputApi.list(templateId),
    retry: false,
    refetchInterval: (q) => (q.state.data && shouldPoll(q.state.data.outputs) ? POLL_MS : false),
  });
  const [filter, setFilter] = useState<OutputFilter>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: outputKeys.list(templateId) });
    void qc.invalidateQueries({ queryKey: archiveKeys.template(templateId) });
  };
  useEffect(() => {
    if (!feed) return;
    const offs = (["outputs", "build", "estimate", "variants"] as const).map((name) =>
      feed.onTemplateEvent(name, () => {
        void qc.invalidateQueries({ queryKey: outputKeys.list(templateId) });
        // 开着的播放弹层里的花费明细也跟着换（出片结束、重新估价会改它，9.2 审查 S2-4）
        void qc.invalidateQueries({ queryKey: ["output-costs"] });
      }),
    );
    return () => offs.forEach((off) => off());
  }, [feed, qc, templateId]);

  const outputs = useMemo(() => list.data?.outputs ?? [], [list.data]);
  // 勾选只留还能下载的（删了、或刷新后变成不能下载的自动去掉）
  const picked = outputs.filter((o) => selected.has(o.id) && o.downloadable).map((o) => o.id);
  const open = outputs.find((o) => o.id === openId) ?? null;

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => outputApi.rename(id, name),
    onSuccess: () => {
      setRenamingId(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => outputApi.remove(id),
    onMutate: () => setDeleteError(null),
    onSuccess: (_r, id) => {
      setOpenId(null);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    onError: (e) => setDeleteError(`没删成：${e.message}`),
    onSettled: refresh,
  });
  const retry = useMutation({
    mutationFn: (id: string) => buildApi.retry(id),
    onMutate: () => setActionError(null),
    onError: (e) => setActionError(`没能重试：${e.message}`),
    onSettled: (_r, _e, id) => {
      refresh();
      void qc.invalidateQueries({ queryKey: outputKeys.costs(id) });
    },
  });

  if (list.isPending) return <Skeleton />;
  // 只有第一次就没拿到才整页报错；之后某次重拉失败留着旧数据，网格和正在播放的弹层都不动（9.2 审查 S2-1）
  if (list.error && !list.data) {
    return (
      <QueryErrorState
        error={list.error}
        goneText="这个模板已经不存在了"
        errorText="读不到成片"
        retrying={list.isFetching}
        onRetry={() => void list.refetch()}
      />
    );
  }
  if (outputs.length === 0) {
    return (
      <p className="py-12 text-center text-[13px] text-text-secondary">
        还没有成片。去{" "}
        <Link to="../variants" relative="path" className="text-primary hover:underline">
          ④ 变体
        </Link>{" "}
        提交几条 brief，出完的片子会出现在这里。
      </p>
    );
  }

  const shown = outputs.filter((o) => matchesOutput(o, filter));
  // 勾了的、但被当前筛选藏起来的：照样打包，说一声免得意外（9.2 审查 S2-8）
  const hiddenPicked = picked.filter((id) => !shown.some((o) => o.id === id)).length;
  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      {list.error ? (
        <div role="alert" className="flex items-center gap-2 text-caption text-danger">
          刷新成片失败：{list.error.message}
          <Button variant="ghost" loading={list.isFetching} onClick={() => void list.refetch()}>
            重试
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="筛选" className="flex items-center gap-1">
          {OUTPUT_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              // 同 ④ 队列的筛选（VariantQueue）：同一种控件不各画一套（9.2 第二轮审查 S2-4）
              className={[
                "h-7 rounded-md px-2.5 text-[13px]",
                filter === f.key ? "bg-surface-raised text-text" : "text-text-secondary hover:text-text",
              ].join(" ")}
            >
              {f.label}{" "}
              <span className="font-mono text-caption text-text-tertiary">
                {outputs.filter((o) => matchesOutput(o, f.key)).length}
              </span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <span className="text-caption text-text-secondary">
          已选 {picked.length}
          {hiddenPicked > 0 ? `（${hiddenPicked} 条不在当前筛选）` : ""}
        </span>
        {picked.length > 0 ? (
          <a href={zipUrl(templateId, picked)} download className={PRIMARY_LINK_CLASS}>
            批量下载 zip
          </a>
        ) : (
          <Button variant="primary" disabled disabledReason="先勾选完成的成片">
            批量下载 zip
          </Button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-text-secondary">这个筛选下没有成片。</p>
      ) : (
        <ul aria-label="成片" className={GRID}>
          {shown.map((o: OutputView) => (
            <li key={o.id}>
              <OutputCard
                output={o}
                selected={selected.has(o.id) && o.downloadable}
                onToggle={() => toggle(o.id)}
                onOpen={() => {
                  setActionError(null);
                  setOpenId(o.id);
                }}
                renaming={
                  renamingId === o.id
                    ? { busy: rename.isPending, ...(rename.error ? { error: rename.error.message } : {}) }
                    : null
                }
                onRenameStart={() => {
                  rename.reset();
                  setRenamingId(o.id);
                }}
                onRename={(name) => rename.mutate({ id: o.id, name })}
                onRenameCancel={() => setRenamingId(null)}
              />
            </li>
          ))}
        </ul>
      )}

      <OutputPlayer
        output={open}
        deleting={remove.isPending}
        deleteError={deleteError}
        retrying={retry.isPending}
        actionError={actionError}
        onDelete={() => open && remove.mutate(open.id)}
        onDeleteCancel={() => setDeleteError(null)}
        onRetry={() => open && retry.mutate(open.id)}
        onClose={() => setOpenId(null)}
      />
    </>
  );
}

/** 加载态：封面骨架（SCREEN-008） */
function Skeleton() {
  return (
    <ul aria-label="读取成片" aria-busy className={GRID}>
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="flex flex-col gap-1.5">
          <div className="h-[280px] w-full animate-pulse rounded-md bg-surface" />
          <div className="h-3 w-3/4 animate-pulse rounded-sm bg-surface" />
          <div className="h-3 w-1/2 animate-pulse rounded-sm bg-surface" />
        </li>
      ))}
    </ul>
  );
}
