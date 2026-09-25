import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageIcon } from "lucide-react";
import { useId } from "react";
import type { CheckResult } from "../HealthRow.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Switch } from "../ui/Switch.js";
import { useToast } from "../ui/Toast.js";
import { codexApi, codexKeys, type CodexTry } from "../../lib/codex.js";
import { formatElapsed } from "../../lib/evidence.js";
import { useNow } from "../../lib/useNow.js";
import { useSse } from "../../lib/useSse.js";

/**
 * 设置页「生成服务」里的 Codex 订阅生图一行（REQ-011、DASM-004：一条体检行 + 一个开关，不新增页面）。
 * 行结构照设计稿「生视频通道」：名称 | 模型 | 计费徽标 | 状态 | 启用开关 | 操作。两处与设计稿不同：
 * - 名称列 150px（设计稿 210px）：1280 宽下还要放「试出一张图」按钮，210px 会把模型列挤没（11.3 真浏览器实测）
 * - 操作列是能带转圈与禁用原因的按钮（设计稿是 60px 的「测试」文字），行高因此约 44px（设计稿 36px）
 * 容器窄于 640px（抽屉展开时）不用网格、按内容换行，免得模型与状态两列被挤成 0 宽（11.3 审查 S2-M1）；
 * 网格里模型与状态两列按比例分剩下的宽度，状态列不先吃满（第二轮审查 R2-L1）。
 *
 * 能不能开、能不能试看体检的 `ready`（CLI 与登录都好）：只是 Provider 包没同步上时状态仍是 warn，
 * 但开关与试图会当场重试同步，所以照样能点（11.3 审查 S1-M1）。关着且没准备好不让开；开着的随时能关（AC-033）。
 */
export function CodexImage({
  check,
  enabled,
  saving,
  onToggle,
}: {
  /** 体检里 id 为 codex 的那一项；还在检测时没有 */
  check: CheckResult | undefined;
  enabled: boolean;
  saving: boolean;
  onToggle: (next: boolean) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const hintId = useId();
  const ok = check?.status === "pass";
  const usable = check !== undefined && (check.ready ?? ok);
  const latest = useQuery({
    queryKey: codexKeys.try,
    queryFn: () => codexApi.latestTry(),
    // 出一张图要几分钟：结果主要靠 SSE 的 codex-try 事件，轮询只是断线时的兜底
    refetchInterval: (q) => (q.state.data?.status === "running" ? 5_000 : false),
  });
  useSse(["global"], (event) => {
    if (event === "codex-try") void qc.invalidateQueries({ queryKey: codexKeys.try });
  });
  const start = useMutation({
    mutationFn: () => codexApi.startTry(),
    onSuccess: (next) => qc.setQueryData(codexKeys.try, next),
    // 标题之后给服务端 message 的原文（不是整个 JSON 包，11.3 审查 L1）
    onError: (e: Error) => toast.push("danger", "没能开始出图", e.message),
  });

  const tryState = latest.data ?? null;
  const running = tryState?.status === "running";
  const notReady = check === undefined ? "体检还没出结果" : `Codex 没准备好：${check.detail}`;
  const hint = check && !ok ? <Hint check={check} enabled={enabled} usable={usable} /> : null;

  return (
    <div className="@container flex flex-col gap-2" aria-label="Codex 订阅生图">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border py-1.5 @[640px]:grid @[640px]:grid-cols-[150px_minmax(0,1fr)_110px_minmax(0,1fr)_44px_auto]">
        <span className="shrink-0 text-[13px] text-text">Codex 订阅生图</span>
        <span
          className="min-w-0 truncate font-mono text-[11px] text-text-secondary"
          title="承接 gpt-image-2，由 Codex 的 $imagegen 出图"
        >
          gpt-image-2
        </span>
        <span className="shrink-0">
          <Badge>零价 · 记张数</Badge>
        </span>
        <span className="flex min-w-0 basis-full items-center gap-1.5 @[640px]:basis-auto">
          <span
            aria-hidden
            className={["size-2 shrink-0 rounded-full", ok ? "bg-success" : "bg-text-tertiary"].join(" ")}
          />
          <span
            className={["truncate text-[12px]", ok ? "text-success" : "text-text-secondary"].join(" ")}
            title={check?.detail}
          >
            {check === undefined ? "检测中…" : ok ? `✓ ${check.detail}` : check.detail}
          </span>
        </span>
        <Switch
          label="启用 Codex 订阅生图"
          checked={enabled}
          disabled={saving || (!enabled && !usable)}
          disabledReason={saving ? "正在保存" : notReady}
          {...(hint ? { describedBy: hintId } : {})}
          onChange={onToggle}
        />
        <Button
          variant="secondary"
          icon={<ImageIcon aria-hidden className="size-4" />}
          loading={start.isPending || running}
          disabled={!usable || running}
          disabledReason={running ? "上一张还在出" : notReady}
          {...(hint ? { "aria-describedby": hintId } : {})}
          onClick={() => start.mutate()}
        >
          试出一张图
        </Button>
      </div>
      {hint ? (
        <p id={hintId} className="text-caption text-warning">
          {hint}
        </p>
      ) : null}
      {tryState ? <TryResult state={tryState} /> : null}
    </div>
  );
}

/** 没通过时的一句话：键盘与读屏靠 aria-describedby 也读得到（11.3 审查 L4） */
function Hint({ check, enabled, usable }: { check: CheckResult; enabled: boolean; usable: boolean }) {
  if (usable) return <>{check.detail}</>;
  const fix = check.fix ? (
    <>
      执行 <code className="font-mono">{check.fix}</code> 后点「重新检测」。
    </>
  ) : (
    check.detail
  );
  // 已经开着：不是「不能打开」，而是「开着但出图会失败」（11.3 审查 L3）
  return enabled ? <>已开着，但 Codex 没准备好，出图会失败：{fix}</> : <>没准备好，开关不能打开：{fix}</>;
}

function TryResult({ state }: { state: CodexTry }) {
  const now = useNow(state.status === "running");
  // Worker 没停掉：它可能还挂着、还在花订阅额度，写出来（11.3 审查 L2）
  const cleanup = state.cleanup ? <p className="text-caption text-warning">{state.cleanup}</p> : null;
  if (state.status === "running") {
    return (
      <p role="status" className="text-caption text-text-secondary">
        正在用 Codex 出一张测试图… 已用 {formatElapsed(now - Date.parse(state.startedAt))}（一张通常几分钟）
      </p>
    );
  }
  const took = state.durationMs === null ? "" : `，用时 ${formatElapsed(state.durationMs)}`;
  if (state.status === "done" && state.hasImage) {
    return (
      <div className="flex flex-col gap-1">
        <div role="status" aria-label="试出的图" className="flex items-end gap-3">
          <img
            src={codexApi.imageUrl(state.id)}
            alt="Codex 试出的测试图"
            className="size-40 rounded-md border border-border bg-bg object-contain"
          />
          <span className="text-caption text-success">出图成功{took}，花费 $0（订阅额度）</span>
        </div>
        {cleanup}
      </div>
    );
  }
  return (
    <div role="alert" aria-label="试出一张图失败" className="flex flex-col gap-1">
      <span className="text-caption text-danger">出图失败{took}：</span>
      <pre className="max-h-40 overflow-auto rounded-md border border-danger/40 bg-bg p-2 font-mono text-[12px] break-all whitespace-pre-wrap text-danger">
        {state.error ?? "没有给出原因"}
      </pre>
      {cleanup}
    </div>
  );
}
