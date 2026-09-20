import { NavLink } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { InlineNameEditor } from "../components/ui/InlineNameEditor.js";
import { RowMenu } from "../components/ui/RowMenu.js";
import type { SidebarClient, TemplateStatus } from "../lib/archive.js";
import type { useArchiveActions } from "./useArchiveActions.js";

/**
 * 模板状态点（SCREEN-001）。
 *
 * 形状和颜色一起区分，不能只靠颜色（Design-Brief 8.2）。尤其是「复刻中」和
 * 「待验货」都是主色：只拿 animate-pulse 区分的话，prefers-reduced-motion 下
 * 动画被压到 0.01ms 瞬间跑完，两个状态会渲染得一模一样。所以「待验货」改成空心圈。
 * label 给屏幕阅读器读，点本身是 aria-hidden。
 */
const TEMPLATE_DOT: Record<TemplateStatus, { dot: string; label: string }> = {
  importing: { dot: "bg-text-tertiary", label: "导入中" },
  cloning: { dot: "bg-primary animate-pulse", label: "复刻中" },
  awaiting_review: { dot: "border-2 border-primary bg-transparent", label: "待验货" },
  approved: { dot: "bg-success", label: "已验货" },
  failed: { dot: "bg-danger", label: "失败" },
};

interface Props {
  client: SidebarClient;
  open: boolean;
  onToggle: () => void;
  actions: ReturnType<typeof useArchiveActions>;
}

/** 侧栏树的一个客户节点：客户行 + 展开后的模板行 */
export function ClientNode({ client, open, onToggle, actions }: Props) {
  const { editing, editError, beginEdit, closeEditor, clearEditError, rename, askDelete } = actions;
  const editingClient = editing?.kind === "client" && editing.id === client.id;

  return (
    <li>
      {editingClient ? (
        <InlineNameEditor
          initialValue={client.name}
          placeholder="客户名"
          busy={rename.isPending}
          error={editError}
          onDirty={clearEditError}
          onCommit={(name) => rename.mutate({ kind: "client", id: client.id, name })}
          onCancel={closeEditor}
        />
      ) : (
        <div className="group flex h-8 items-center gap-2 px-3 hover:bg-surface-raised">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-medium"
          >
            {open ? (
              <ChevronDown aria-hidden className="size-2.5 shrink-0 text-text-tertiary" />
            ) : (
              <ChevronRight aria-hidden className="size-2.5 shrink-0 text-text-tertiary" />
            )}
            <span className="truncate">{client.name}</span>
          </button>
          <RowMenu
            label={`${client.name} 的操作`}
            items={[
              { label: "重命名", onSelect: () => beginEdit({ kind: "client", id: client.id, name: client.name }) },
              {
                label: "删除",
                tone: "danger",
                onSelect: () => void askDelete("client", client.id, client.name),
              },
            ]}
          />
        </div>
      )}

      {open ? (
        <ul className="flex flex-col">
          {client.templates.map((tpl) => {
            const editingTpl = editing?.kind === "template" && editing.id === tpl.id;
            if (editingTpl) {
              return (
                <li key={tpl.id}>
                  <InlineNameEditor
                    initialValue={tpl.name}
                    placeholder="模板名"
                    busy={rename.isPending}
                    error={editError}
                    indentClass="pl-[30px]"
                    onDirty={clearEditError}
                    onCommit={(name) => rename.mutate({ kind: "template", id: tpl.id, name })}
                    onCancel={closeEditor}
                  />
                </li>
              );
            }
            const status = TEMPLATE_DOT[tpl.status];
            return (
              <li key={tpl.id} className="group relative">
                <NavLink
                  to={`/clients/${client.id}/templates/${tpl.id}`}
                  className={({ isActive }: { isActive: boolean }) =>
                    [
                      // 右边留到 32px 而不是设计稿的 12px，是给行尾「…」菜单让位
                      "mx-1.5 flex h-8 items-center gap-2 rounded-md pr-8 pl-[30px] text-[13px]",
                      isActive ? "bg-surface-raised text-text" : "text-text-secondary hover:bg-surface-raised",
                    ].join(" ")
                  }
                >
                  {({ isActive }: { isActive: boolean }) => (
                    <>
                      <span
                        aria-hidden
                        className={[
                          "inline-block size-2 shrink-0 rounded-full",
                          status.dot,
                          isActive ? "dot-ring" : "",
                        ].join(" ")}
                      />
                      <span className="truncate">{tpl.name}</span>
                      <span className="sr-only">{status.label}</span>
                    </>
                  )}
                </NavLink>
                <div className="absolute top-1/2 right-3 -translate-y-1/2">
                  <RowMenu
                    label={`${tpl.name} 的操作`}
                    items={[
                      { label: "重命名", onSelect: () => beginEdit({ kind: "template", id: tpl.id, name: tpl.name }) },
                      {
                        label: "删除",
                        tone: "danger",
                        onSelect: () => void askDelete("template", tpl.id, tpl.name),
                      },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
