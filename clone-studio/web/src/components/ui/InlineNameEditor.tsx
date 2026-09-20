import { useEffect, useRef, useState } from "react";

interface Props {
  /** 重命名时是原名；新建时留空 */
  initialValue?: string;
  placeholder?: string;
  busy?: boolean;
  /** 后端回来的错误原文，红字挂在输入框下（REQ-001「重名/超长在输入框下红字」） */
  error?: string;
  /** 左内边距对齐所在行的文字位置 */
  indentClass?: string;
  /** 用户开始改字时通知父级清掉上一次的错误，别让"名称已存在"挂在新名字下面 */
  onDirty?: () => void;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/**
 * 就地改名 / 就地新建的输入框。
 *
 * Enter 提交、Esc 取消、失焦取消。失焦不提交是刻意的：提交撞上重名会在框下
 * 出红字，而失焦提交会把输入框连同那条红字一起收走，AC-003 要看的提示就没了。
 */
export function InlineNameEditor({
  initialValue = "",
  placeholder,
  busy = false,
  error,
  indentClass = "pl-3",
  onDirty,
  onCommit,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = (): void => {
    const name = value.trim();
    if (!name || busy) return;
    onCommit(name);
  };

  return (
    <div className={`flex flex-col gap-0.5 py-0.5 pr-3 ${indentClass}`}>
      <input
        ref={ref}
        value={value}
        // 提交中用 readOnly 而不是 disabled：disabled 会把焦点弹走，
        // 一弹走就触发 onBlur 的取消，失败后的红字也就留不住了
        readOnly={busy}
        aria-busy={busy || undefined}
        placeholder={placeholder}
        autoComplete="off"
        aria-label={placeholder ?? "名称"}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) onDirty?.();
        }}
        onBlur={() => {
          if (!busy) onCancel();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        className={[
          "h-7 w-full rounded border bg-bg px-1.5 text-[13px] text-text",
          "placeholder:text-text-tertiary read-only:opacity-60",
          error ? "border-danger" : "border-primary",
        ].join(" ")}
      />
      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
