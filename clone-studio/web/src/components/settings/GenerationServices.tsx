import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CheckResult } from "../HealthRow.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Input.js";
import { useToast } from "../ui/Toast.js";
import { api, TIMEOUT_MS, type ApiError } from "../../lib/api.js";
import type { Settings, VerifyResult } from "../../lib/types.js";
import { CodexImage } from "./CodexImage.js";

/** 设置页「生成服务」分区（SCREEN-009）：TokenDance key 与 Codex 订阅生图。从 SettingsPage 拆出，页面文件保持在 300 行内 */
export function GenerationServices({
  settings: s,
  codexCheck,
  saving,
  onPatch,
}: {
  settings: Settings | undefined;
  codexCheck: CheckResult | undefined;
  saving: boolean;
  onPatch: (body: Partial<Settings>) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tokenDraft, setTokenDraft] = useState("");

  const saveSecret = useMutation({
    // 后端注册的是 PUT（设置某个具名凭据，幂等替换）。这里曾经发的是 POST，
    // 结果是一路 404，而下面原本没有 onError，失败被完全吞掉——用户点保存
    // 毫无反应，接着验证又说"未配置 key"，看上去像两个 bug
    mutationFn: (value: string | null) =>
      api.put<{ masked: string | null }>("/api/settings/secret", { key: "tokendance.apiKey", value }),
    onSuccess: (_result, value) => {
      setTokenDraft("");
      toast.push("success", value === null ? "已清除 TokenDance key" : "已保存，接着点「验证」");
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["health", "checks"] });
    },
    onError: (e: unknown) => {
      const err = e as ApiError;
      toast.push("danger", "保存失败", err.detail ?? err.message);
    },
  });

  const verify = useMutation({
    mutationFn: () => api.post<VerifyResult>("/api/settings/verify/tokendance", undefined, TIMEOUT_MS.verify),
    onSuccess: (result) => {
      if (result.ok) {
        toast.push("success", "TokenDance key 验证通过");
      } else {
        // 验证失败要显示服务端返回的原因原文（AC-023）
        const reason =
          [result.status ? `HTTP ${result.status}` : null, result.detail, result.error].filter(Boolean).join("\n") ||
          "未给出原因";
        toast.push("danger", "TokenDance key 验证失败", reason);
      }
      void qc.invalidateQueries({ queryKey: ["health", "checks"] });
    },
    onError: (e: unknown) => {
      const err = e as ApiError;
      toast.push("danger", "验证请求失败", err.detail ?? err.message);
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="w-80">
          <Input
            label="TokenDance API key"
            mono
            type="password"
            autoComplete="off"
            placeholder={s?.credentials.tokendance ?? "未配置"}
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            hint={s?.credentials.tokendance ? `已保存：${s.credentials.tokendance}` : "只存在本机，界面只回打码值"}
          />
        </div>
        <Button
          variant="secondary"
          loading={saveSecret.isPending}
          disabled={tokenDraft.trim().length === 0}
          disabledReason="先填入 key"
          onClick={() => saveSecret.mutate(tokenDraft)}
        >
          保存
        </Button>
        <Button
          variant="primary"
          loading={verify.isPending}
          disabled={!s?.credentials.tokendance}
          disabledReason="先保存一个 key"
          onClick={() => verify.mutate()}
        >
          验证
        </Button>
        {s?.credentials.tokendance ? (
          <Button variant="ghost" onClick={() => saveSecret.mutate(null)} loading={saveSecret.isPending}>
            清除
          </Button>
        ) : null}
      </div>
      <p className="text-caption text-text-tertiary">HypiHub（可选，补配音 TTS 等）的浏览器授权连接在 Phase 6 接入。</p>
      <CodexImage
        check={codexCheck}
        enabled={s?.codexProviderEnabled ?? false}
        saving={saving}
        onToggle={(next) => onPatch({ codexProviderEnabled: next })}
      />
    </div>
  );
}
