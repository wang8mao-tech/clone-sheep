import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatActivityTime } from "../../lib/format.js";
import {
  KIND_LABEL,
  probeText,
  profileApi,
  profileKeys,
  type ModelProfile,
  type ProbeResult,
} from "../../lib/model-profiles.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { ConfirmDangerDialog } from "../ui/ConfirmDangerDialog.js";
import { QueryErrorState } from "../ui/QueryErrorState.js";
import { useToast } from "../ui/Toast.js";

/**
 * SCREEN-009「Agent 模型」：档案列表 CMP-010 管理视图（Design-Brief）——名称、类型、模型 id、看图 / 搜索能力徽标、
 * 已验证时间、默认标记；行内「测试连接」「设为默认」「编辑」「删除」。添加与编辑在右侧表单面板（ModelProfilePanel）。
 */

/**
 * 一次测试没通过的记录。记下当时的连接配置：档案改过之后这条就不再显示（它说的是旧配置，10.3 审查 S1-L3）；
 * `sent` 区分「上游回了失败」（服务端已把档案标为未验证）与「请求本身没成」（什么都没记）
 */
interface Failure {
  sig: string;
  sent: boolean;
  result: ProbeResult;
}

const signature = (p: ModelProfile) => [p.baseUrl, p.modelId, p.token, p.supportsVision].join("|");

/** 各行各自的进行中：两行一起测时，前一行的转圈不能被后一行抢走（10.3 审查 S2-M2） */
function usePending() {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const add = (id: string) => setIds((s) => new Set(s).add(id));
  const drop = (id: string) =>
    setIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  return { has: (id: string) => ids.has(id), add, drop };
}

export function ModelProfiles({
  onEdit,
  onDeleted,
}: {
  onEdit: (profile: ModelProfile, opener: HTMLElement | null) => void;
  /** 删掉了哪个档案：开着它的编辑面板要跟着关（10.3 第二轮审查 S2-L2） */
  onDeleted?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const profiles = useQuery({ queryKey: profileKeys.list, queryFn: () => profileApi.list() });
  const refresh = () => void qc.invalidateQueries({ queryKey: profileKeys.list });
  const [failures, setFailures] = useState<Record<string, Failure>>({});
  const [deleting, setDeleting] = useState<ModelProfile | null>(null);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const testing = usePending();
  const defaulting = usePending();
  const setFailure = (id: string, failure: Failure | null) =>
    setFailures((all) => {
      const next = { ...all };
      if (failure) next[id] = failure;
      else delete next[id];
      return next;
    });

  const test = useMutation({
    mutationFn: (p: ModelProfile) => profileApi.test(p.id),
    onMutate: (p) => testing.add(p.id),
    onSettled: (_data, _error, p) => testing.drop(p.id),
    onSuccess: ({ result, stale }, p) => {
      refresh();
      // 测试途中改过：结论没记到新配置上，也不该当成新配置的失败摆出来
      if (stale) {
        toast.push("warning", `「${p.name}」测试期间被改过`, "结论没有记到新配置上，再测一次。");
        return;
      }
      setFailure(p.id, result.ok ? null : { sig: signature(p), sent: true, result });
      if (result.ok) toast.push("success", `「${p.name}」连接正常`);
    },
    onError: (e: Error, p) =>
      setFailure(p.id, { sig: signature(p), sent: false, result: { ok: false, error: e.message } }),
  });
  const setDefault = useMutation({
    mutationFn: (p: ModelProfile) => profileApi.setDefault(p.id),
    onMutate: (p) => defaulting.add(p.id),
    onSettled: (_data, _error, p) => defaulting.drop(p.id),
    onSuccess: refresh,
    onError: (e: Error) => toast.push("danger", "设为默认失败", e.message),
  });
  const remove = useMutation({
    mutationFn: (p: ModelProfile) => profileApi.remove(p.id),
    onSuccess: (_data, p) => {
      setDeleting(null);
      onDeleted?.(p.id);
      refresh();
    },
    onError: (e: Error) => setDeleteError(e.message),
  });

  if (profiles.isPending) {
    return (
      <ul aria-label="读取模型档案" aria-busy className="flex flex-col gap-2">
        {[0, 1].map((i) => (
          <li key={i} className="h-11 animate-pulse rounded-md bg-bg" />
        ))}
      </ul>
    );
  }
  if (profiles.error) {
    return (
      <QueryErrorState
        error={profiles.error}
        goneText="读不到模型档案"
        errorText="读不到模型档案"
        retrying={profiles.isFetching}
        onRetry={() => void profiles.refetch()}
      />
    );
  }

  const list = profiles.data.profiles;
  return (
    <div className="flex flex-col gap-2">
      {list.length === 1 ? (
        <p className="text-caption text-text-secondary">
          现在只有内置的本机订阅。手上有别家模型的 API key，点「添加模型」加进来，之后在 ①参考 与 ④变体 按任务选。
        </p>
      ) : null}
      <ul aria-label="模型档案" className="flex flex-col">
        {list.map((p) => {
          const failure = failures[p.id];
          const shown = failure && failure.sig === signature(p) ? failure : undefined;
          return (
            <li key={p.id} className="flex flex-col gap-1.5 border-b border-border py-2 last:border-b-0">
              <ProfileRow
                profile={p}
                testing={testing.has(p.id)}
                settingDefault={defaulting.has(p.id)}
                onTest={() => test.mutate(p)}
                onDefault={() => setDefault.mutate(p)}
                onEdit={(opener) => onEdit(p, opener)}
                onDelete={() => {
                  setDeleteError(undefined);
                  setDeleting(p);
                }}
              />
              {shown ? (
                <div role="alert" aria-label={`「${p.name}」测试失败`} className="flex flex-col gap-1">
                  <span className="text-caption text-danger">
                    {shown.sent ? "测试连接失败，档案标为未验证：" : "测试请求没有完成，档案状态没变："}
                  </span>
                  <pre className="max-h-40 overflow-auto rounded-md border border-danger/40 bg-bg p-2 font-mono text-[12px] break-all whitespace-pre-wrap text-danger">
                    {probeText(shown.result)}
                  </pre>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ConfirmDangerDialog
        open={deleting !== null}
        title={`删除模型档案「${deleting?.name ?? ""}」`}
        confirmName={deleting?.name ?? ""}
        impacts={[
          "档案与它的 API key 一起删掉，删了不能恢复",
          "用过它的历史任务照旧显示当时的档案名与模型 id",
          "还有没结束的任务在用它时删不了",
          ...(deleting?.isDefault ? ["它是默认档案：删掉后默认回到本机订阅"] : []),
        ]}
        confirmLabel="删除档案"
        busy={remove.isPending}
        {...(deleteError ? { error: deleteError } : {})}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

/**
 * 一行：左边信息（两行：名称与徽标；模型 id、base_url 与打码 key、验证状态），右边动作。
 * 不换行：左边 basis-0 可以收窄，长名称 / 长 base_url 走省略号，动作永远在右边同一处（10.3 审查 S2-M3）
 */
function ProfileRow({
  profile: p,
  testing,
  settingDefault,
  onTest,
  onDefault,
  onEdit,
  onDelete,
}: {
  profile: ModelProfile;
  testing: boolean;
  settingDefault: boolean;
  onTest: () => void;
  onDefault: () => void;
  onEdit: (opener: HTMLElement | null) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 basis-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-medium text-text" title={p.name}>
            {p.name}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {p.isDefault ? <Badge tone="primary">默认</Badge> : null}
            <Badge tone="neutral">{KIND_LABEL[p.kind]}</Badge>
            {p.supportsVision ? <Badge tone="info">看图</Badge> : null}
            {p.supportsWebSearch ? <Badge tone="info">搜索</Badge> : null}
            {p.budgetNote ? (
              <Badge tone="warning" title={p.budgetNote}>
                无单价
              </Badge>
            ) : null}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-3 text-caption text-text-secondary">
          <span className="min-w-0 truncate font-mono" title={p.modelId ?? "订阅默认模型"}>
            {p.modelId ?? "订阅默认模型"}
          </span>
          <span className={`shrink-0 ${p.verifiedAt ? "text-success" : "text-text-tertiary"}`}>
            {p.verifiedAt ? `已验证 · ${formatActivityTime(p.verifiedAt)}` : "未验证"}
          </span>
        </div>
        {p.baseUrl || p.token ? (
          <div className="flex min-w-0 items-center gap-3 font-mono text-caption text-text-tertiary">
            {p.baseUrl ? (
              <span className="min-w-0 truncate" title={p.baseUrl}>
                {p.baseUrl}
              </span>
            ) : null}
            {p.token ? <span className="shrink-0">{p.token}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button onClick={onTest} loading={testing} aria-label={`测试连接 ${p.name}`}>
          测试连接
        </Button>
        {p.isDefault ? null : (
          <Button variant="ghost" onClick={onDefault} loading={settingDefault} aria-label={`设为默认 ${p.name}`}>
            设为默认
          </Button>
        )}
        {p.builtin ? null : (
          <>
            <Button variant="ghost" onClick={(e) => onEdit(e.currentTarget)} aria-label={`编辑 ${p.name}`}>
              编辑
            </Button>
            <Button variant="ghost" onClick={onDelete} aria-label={`删除 ${p.name}`}>
              删除
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
