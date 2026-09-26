import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { EvidenceList } from "../../components/EvidenceList.js";
import { QueryErrorState } from "../../components/ui/QueryErrorState.js";
import { useToast } from "../../components/ui/Toast.js";
import { api, ApiError } from "../../lib/api.js";
import { archiveApi, archiveKeys } from "../../lib/archive.js";
import { evidenceApi, evidenceKeys, type EvidenceState, type SourceMode } from "../../lib/evidence.js";
import type { Settings } from "../../lib/types.js";
import { useInvalidateArchive } from "../../lib/useArchive.js";
import { useSse } from "../../lib/useSse.js";
import { ReferenceForm } from "./ReferenceForm.js";

/**
 * SCREEN-003 模板 · ① 参考（REQ-002，设计稿「① 参考」）。
 *
 * 左：导入表单；右：提交后变为参考视频播放器 + 证据准备清单。
 * 清单状态全部来自 GET /evidence，SSE 只负责让它失效重拉——刷新页面走同一个
 * GET，所以刷新后清单不丢。
 */
export function ReferenceStep() {
  const { clientId = "", templateId = "" } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidateArchive = useInvalidateArchive();

  const template = useQuery({
    queryKey: archiveKeys.template(templateId),
    queryFn: () => archiveApi.template(templateId),
    retry: false,
  });
  const evidence = useQuery({
    queryKey: evidenceKeys.state(templateId),
    queryFn: () => evidenceApi.state(templateId),
    retry: false,
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/api/settings") });

  useSse([`template:${templateId}`], (event) => {
    if (event !== "evidence") return;
    void qc.invalidateQueries({ queryKey: evidenceKeys.state(templateId) });
    // 流水线结束会改 templates.status（cloning / failed），侧栏状态点与步骤条跟着变
    invalidateArchive();
  });

  // REQ-002 成功态：四步全过自动进 ②复刻。三个条件缺一不可：
  // - 在这个模板上亲眼看到过「没完成」：已完成的模板回来看 ①参考 不该被弹走；
  //   记的是模板 id，切到另一个已完成的模板不会被上一个模板的状态误触发
  // - 证据完成，且模板已经进入 cloning：两个查询各自重拉，证据先回来时模板还是
  //   importing，②复刻 仍锁着，跳过去会被布局送回来，之后就再也不跳了（审查实测的竞态）
  const status = evidence.data?.status;
  const templateStatus = template.data?.status;
  const sawIncomplete = useRef<string | null>(null);
  useEffect(() => {
    if (status && status !== "done") sawIncomplete.current = templateId;
    if (status === "done" && templateStatus === "cloning" && sawIncomplete.current === templateId) {
      sawIncomplete.current = null;
      void navigate(`/clients/${clientId}/templates/${templateId}/clone`);
    }
  }, [status, templateStatus, clientId, templateId, navigate]);

  // 来源由页面持有，清单里的「改为上传文件」才能切过去。没选过就跟着模板当前来源
  const [modeDraft, setModeDraft] = useState<SourceMode | null>(null);

  const retry = useMutation({
    mutationFn: (step: Parameters<typeof evidenceApi.retry>[1]) => evidenceApi.retry(templateId, step),
    onSuccess: (state) => {
      qc.setQueryData(evidenceKeys.state(templateId), state);
      invalidateArchive();
    },
    onError: (err) =>
      toast.push(
        "danger",
        err instanceof Error ? err.message : "重试失败",
        err instanceof ApiError ? err.detail : undefined,
      ),
  });

  const failed = template.error ?? evidence.error;
  if (failed) {
    return (
      <QueryErrorState
        error={failed}
        goneText="这个模板已经不存在了。"
        errorText="读不到参考视频的准备状态。"
        retrying={template.isFetching || evidence.isFetching}
        onRetry={() => {
          void template.refetch();
          void evidence.refetch();
        }}
      />
    );
  }

  if (!template.data || !evidence.data) {
    return <p className="text-[13px] text-text-secondary">正在读取参考视频的准备状态…</p>;
  }

  const state = evidence.data;
  const mode = modeDraft ?? (template.data.sourceKind === "file" ? "file" : "url");
  const submitted = state.status !== "idle" || state.steps.some((s) => s.status !== "pending");

  return (
    <div className="flex gap-5">
      <ReferenceForm
        // 换模板时整张表单重建，免得把上一个模板的输入带过来
        key={template.data.id}
        template={template.data}
        locked={state.status === "running" || retry.isPending}
        maxSeconds={settings.data?.referenceMaxSeconds ?? 180}
        mode={mode}
        onModeChange={setModeDraft}
        onStarted={(next) => qc.setQueryData(evidenceKeys.state(templateId), next)}
      />

      {submitted ? (
        <div className="flex min-w-0 flex-1 items-start gap-5">
          <ReferencePlayer templateId={templateId} state={state} />
          <section aria-label="证据准备" className="flex min-w-0 flex-1 flex-col gap-3">
            <h2 className="text-[14px] font-semibold">证据准备</h2>
            <EvidenceList
              state={state}
              retrying={retry.isPending ? retry.variables : undefined}
              onRetry={(step) => retry.mutate(step)}
              onSwitchToUpload={template.data.sourceKind === "url" ? () => setModeDraft("file") : undefined}
            />
            <p className="text-caption text-text-secondary">全部完成后自动开始复刻。失败的步骤可单独重试。</p>
          </section>
        </div>
      ) : (
        <p className="flex-1 self-center text-center text-[13px] text-text-secondary">
          提交后这里显示参考视频和证据准备进度。
        </p>
      )}
    </div>
  );
}

/**
 * 参考视频播放器，9:16 竖屏 198×352（设计稿）。源视频落盘（下载步骤完成）之前
 * 播放接口会 404，这时画占位而不是给一个报错的 <video>。
 */
function ReferencePlayer({ templateId, state }: { templateId: string; state: EvidenceState }) {
  const fetched = state.steps.find((s) => s.step === "fetch");
  const box = "h-[352px] w-[198px] shrink-0 rounded-md border border-border";

  if (fetched?.status !== "done") {
    return (
      <div
        className={`${box} flex items-center justify-center bg-[repeating-linear-gradient(135deg,#1a1c20_0_10px,#15171a_10px_20px)]`}
      >
        <span className="font-mono text-[11px] text-text-tertiary">source.mp4 · 9:16</span>
      </div>
    );
  }
  // 重新导入后文件内容变了而地址没变，用下载完成时间作版本号逼浏览器重取
  const version = encodeURIComponent(fetched.endedAt ?? "");
  return (
    <video
      key={version}
      aria-label="参考视频"
      controls
      preload="metadata"
      src={`/api/templates/${templateId}/reference/video?v=${version}`}
      className={`${box} bg-black object-contain`}
    />
  );
}
