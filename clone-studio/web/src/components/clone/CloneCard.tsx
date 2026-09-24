/** ② 复刻页右栏卡片的外壳：估价卡与出片卡共用。错误态按 Design-Brief §4「红边 + 下方原文」 */
export function CloneCard({
  title,
  badge,
  tone = "default",
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  tone?: "default" | "danger";
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={[
        "flex flex-col gap-3 rounded-lg border bg-surface p-4",
        tone === "danger" ? "border-danger/40" : "border-border",
      ].join(" ")}
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-caption font-medium text-text-secondary">{title}</span>
        {badge}
      </div>
      {children}
    </section>
  );
}
