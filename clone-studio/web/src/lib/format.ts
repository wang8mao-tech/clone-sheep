/** 界面上的数字与时间格式。集中一处，免得每个页面各写一套。 */

/**
 * 花费一律两位小数，等宽显示（Design-Brief 5.2）。
 * 不做「小于一分钱显示 <$0.01」那种取巧——Spec REQ-009 要求花费可核对，
 * 把 0.004 显示成 $0.00 已经够让人困惑了，再加一层转换只会更糟。
 */
export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 最近活动时间。一天内给相对时间（"12 分钟前"），更早给日期。
 * 相对时间对"刚刚在跑什么"最有用，而三天前的东西看具体日期才有意义。
 */
export function formatActivityTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "—";

  const diff = now - at;
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;

  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return sameYear ? md : `${d.getFullYear()} 年 ${md}`;
}

/** 等额度的预计恢复时间（HH:mm）；时间戳坏了给 null，别显示「NaN:NaN」 */
export function formatResumeTime(resumeAt: string | null): string | null {
  const at = resumeAt ? new Date(resumeAt) : null;
  return at && !Number.isNaN(at.getTime())
    ? at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : null;
}
