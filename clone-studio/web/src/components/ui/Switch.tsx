/**
 * 开关（设计稿「设置 · 生视频通道」行里的启用开关）：28×16 圆角轨道，开 = 强调色底 + 深色圆点在右，
 * 关 = 边线色底 + 三级文字色圆点在左。真按钮 + role="switch"，键盘可达、读屏读得出开关状态。
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  disabledReason,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** 读屏用的名字（界面上旁边已有可见文字时照样要给） */
  label: string;
  disabled?: boolean;
  /** 不可用时悬停说明为什么 */
  disabledReason?: string;
  /** 界面上写着原因的那一行的 id：键盘与读屏用户拿不到悬停提示（11.3 审查 L4） */
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      title={disabled && disabledReason ? disabledReason : undefined}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-primary" : "bg-border",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "absolute top-0.5 size-3 rounded-full transition-[left]",
          checked ? "left-[14px] bg-on-primary" : "left-0.5 bg-text-tertiary",
        ].join(" ")}
      />
    </button>
  );
}
