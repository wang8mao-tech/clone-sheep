import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { Button } from "../../components/ui/Button.js";
import { Input, Textarea } from "../../components/ui/Input.js";
import { Select } from "../../components/ui/Select.js";
import { useToast } from "../../components/ui/Toast.js";
import { ApiError } from "../../lib/api.js";
import { archiveApi, type TemplateDetail } from "../../lib/archive.js";
import { inlineNameError, useInvalidateArchive } from "../../lib/useArchive.js";
import {
  ACCEPTED_EXTENSIONS,
  checkFile,
  checkUrl,
  evidenceApi,
  LANGUAGE_OPTIONS,
  NOTE_MAX,
  type EvidenceState,
  type SourceMode,
} from "../../lib/evidence.js";
import { ModelSelect } from "../../components/ModelSelect.js";
import { useProfileChoice } from "../../lib/useProfileChoice.js";

/** 上传与点火接口里跟来源有关的错误，贴在链接/文件下；其余走 toast */
const SOURCE_CODES = new Set(["BAD_FILE_TYPE", "FILE_TOO_LARGE", "EMPTY_FILE", "NO_FILE", "INVALID_BODY"]);

const MODES: readonly SourceMode[] = ["url", "file"];

interface Props {
  template: TemplateDetail;
  /** 流水线正在跑：整张表单锁住，后端此时也会以 EVIDENCE_BUSY 拒绝 */
  locked: boolean;
  /** 时长上限跟设置走（REQ-008 referenceMaxSeconds），后端校验用的也是它 */
  maxSeconds: number;
  /** 来源由页面持有：链接失败时清单里的「改为上传文件」要能切过来 */
  mode: SourceMode;
  onModeChange: (mode: SourceMode) => void;
  onStarted: (state: EvidenceState) => void;
}

/**
 * SCREEN-003 左侧导入表单（设计稿「① 参考」，卡片宽 420px）。
 *
 * 链接与上传二选一；上传先落盘拿到 uploadPath 再点火证据流水线。
 * 失败后表单不清空、可切换来源重新提交——AC-006 的「可改为上传文件后重试」。
 *
 * 每个字段只存「用户改过的草稿」，没改过就显示模板当前值：页头就地改了名、
 * 别处换了来源，这里跟着变，提交时也不会拿一份旧值把新值改回去（审查实测）。
 */
export function ReferenceForm({ template, locked, maxSeconds, mode, onModeChange, onStarted }: Props) {
  const toast = useToast();
  const invalidateArchive = useInvalidateArchive();
  const fileInput = useRef<HTMLInputElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const fileErrorId = useId();

  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [languageDraft, setLanguageDraft] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fieldError, setFieldError] = useState<{ source?: string; name?: string; note?: string }>({});

  const url = urlDraft ?? template.sourceUrl ?? "";
  const name = nameDraft ?? template.name;
  const language = languageDraft ?? template.language ?? "zh";
  const note = noteDraft ?? template.note ?? "";
  // 复刻要看参考视频的帧：只给支持看图的档案（REQ-010 MUST，AC-027）
  const model = useProfileChoice("vision");

  const submit = useMutation({
    mutationFn: async () => {
      // 只有用户动过模板名才改名；没动过就别碰，页头可能刚改过
      if (nameDraft !== null && nameDraft.trim() !== template.name) {
        try {
          await archiveApi.renameTemplate(template.id, nameDraft.trim());
        } catch (err) {
          throw new RenameError(err);
        }
        invalidateArchive();
        setNameDraft(null);
      }
      const source =
        mode === "url" ? { url: url.trim() } : { uploadPath: (await evidenceApi.upload(file as File)).uploadPath };
      return evidenceApi.start(template.id, {
        language,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(model.profileId ? { profileId: model.profileId } : {}),
        ...source,
      });
    },
    onSuccess: (state) => {
      invalidateArchive();
      onStarted(state);
    },
    onError: (failure) => {
      let err: unknown = failure;
      if (failure instanceof RenameError) {
        const message = inlineNameError(failure.original);
        if (message) {
          setFieldError({ name: message });
          return;
        }
        err = failure.original;
      }
      if (err instanceof ApiError && err.code && SOURCE_CODES.has(err.code)) {
        setFieldError({ source: err.message });
        return;
      }
      toast.push(
        "danger",
        err instanceof Error ? err.message : "提交失败",
        err instanceof ApiError ? err.detail : undefined,
      );
    },
  });

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const errors = {
      source: mode === "url" ? checkUrl(url) : file ? checkFile(file) : "先选一个视频文件。",
      name: name.trim() ? undefined : "模板名不能为空。",
      note: note.length > NOTE_MAX ? `复刻备注最多 ${NOTE_MAX} 字。` : undefined,
    };
    setFieldError(errors);
    if (errors.source || errors.name || errors.note) return;
    submit.mutate();
  };

  const pickMode = (next: SourceMode): void => {
    onModeChange(next);
    setFieldError({});
  };

  // radiogroup 的键盘约定：只有选中项在 Tab 序列里，方向键切换（WAI-ARIA）
  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length] as SourceMode;
    pickMode(next);
    radios.current[MODES.indexOf(next)]?.focus();
  };

  const disabled = locked || submit.isPending;
  // 档案读到了、却一个支持看图的都没有：不能提交（Design-Brief SCREEN-003 禁用态：提交按钮禁用，下方一行说明）
  const noProfile = model.profiles !== undefined && model.profileId === null;

  return (
    <form
      aria-label="导入参考视频"
      onSubmit={onSubmit}
      className="flex w-[420px] shrink-0 flex-col gap-3.5 self-start rounded-lg border border-border bg-surface p-5"
    >
      <h2 className="text-[14px] font-semibold">导入参考视频</h2>

      <div role="radiogroup" aria-label="来源" className="flex items-center gap-1">
        {MODES.map((m, i) => (
          <button
            key={m}
            ref={(el) => {
              radios.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={mode === m}
            tabIndex={mode === m ? 0 : -1}
            disabled={disabled}
            onClick={() => pickMode(m)}
            onKeyDown={onRadioKey}
            className={[
              "rounded-md border px-3 py-[5px] text-caption transition-colors disabled:opacity-40",
              mode === m
                ? "border-border bg-surface-raised text-text"
                : "border-transparent text-text-secondary hover:text-text",
            ].join(" ")}
          >
            {m === "url" ? "粘贴链接" : "上传文件"}
          </button>
        ))}
      </div>

      {mode === "url" ? (
        <Input
          label="视频链接"
          mono
          value={url}
          disabled={disabled}
          placeholder="https://"
          error={fieldError.source}
          onChange={(e) => setUrlDraft(e.target.value)}
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-text-secondary">视频文件</span>
          {/* 真正的 input 藏起来且不进 Tab 序列：可见的按钮才是焦点落点，免得一个控件两个 Tab 停靠 */}
          <input
            ref={fileInput}
            type="file"
            tabIndex={-1}
            aria-label="选择视频文件"
            accept={ACCEPTED_EXTENSIONS.join(",")}
            className="sr-only"
            disabled={disabled}
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              setFile(picked);
              setFieldError({ source: picked ? checkFile(picked) : undefined });
            }}
          />
          <button
            type="button"
            disabled={disabled}
            aria-invalid={fieldError.source ? true : undefined}
            aria-describedby={fieldError.source ? fileErrorId : undefined}
            onClick={() => fileInput.current?.click()}
            className={[
              "flex h-16 items-center justify-center gap-2 rounded-md border border-dashed bg-bg px-3 text-[13px]",
              "transition-colors hover:bg-surface-raised disabled:opacity-40",
              fieldError.source ? "border-danger" : "border-border",
            ].join(" ")}
          >
            <Upload aria-hidden className="size-4 shrink-0 text-text-tertiary" />
            <span className={["truncate", file ? "text-text" : "text-text-tertiary"].join(" ")}>
              {file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : "点这里选择文件"}
            </span>
          </button>
          {fieldError.source ? (
            <p id={fileErrorId} role="alert" className="font-mono text-caption text-danger">
              {fieldError.source}
            </p>
          ) : null}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="模板名"
          value={name}
          disabled={disabled}
          error={fieldError.name}
          onChange={(e) => setNameDraft(e.target.value)}
        />
        <Select
          label="视频语言"
          value={language}
          disabled={disabled}
          options={LANGUAGE_OPTIONS}
          onChange={(e) => setLanguageDraft(e.target.value)}
        />
      </div>

      <ModelSelect
        need="vision"
        profiles={model.profiles}
        value={model.profileId}
        onChange={model.setProfileId}
        error={model.error}
        onRetry={model.retry}
        disabled={disabled}
      />

      <Textarea
        label="复刻备注"
        rows={3}
        value={note}
        disabled={disabled}
        placeholder="想保留什么、不在意什么（可选）"
        error={fieldError.note}
        hint={note.length > NOTE_MAX * 0.9 ? `${note.length} / ${NOTE_MAX}` : undefined}
        onChange={(e) => setNoteDraft(e.target.value)}
      />

      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11px] text-text-tertiary">mp4 / mov / webm · ≤500 MB · 3-{maxSeconds} 秒</span>
        <Button
          type="submit"
          variant="primary"
          loading={submit.isPending}
          disabled={locked || noProfile}
          disabledReason={locked ? "证据准备正在跑，等它结束" : "没有支持看图的模型档案"}
        >
          {submit.isPending && mode === "file" ? "上传中" : "开始复刻"}
        </Button>
      </div>
    </form>
  );
}

/** 改名这一步的失败单独包一层：同一个 INVALID_BODY，来自改名就该贴在模板名下 */
class RenameError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "RenameError";
  }
}
