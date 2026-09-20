import { NavLink } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { InlineNameEditor } from "../components/ui/InlineNameEditor.js";
import { RowMenu } from "../components/ui/RowMenu.js";
import { TemplateDot } from "../components/ui/TemplateDot.js";
import type { SidebarClient } from "../lib/archive.js";
import type { useArchiveActions } from "./useArchiveActions.js";

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
          {/* 箭头只管展开，名字进客户页——合成一个按钮的话，想看下面的模板就
              不得不先跳一次页，想进客户页又只能靠别处入口 */}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? "折叠" : "展开"} ${client.name}`}
            className="shrink-0 text-text-tertiary"
          >
            {open ? (
              <ChevronDown aria-hidden className="size-2.5" />
            ) : (
              <ChevronRight aria-hidden className="size-2.5" />
            )}
          </button>
          <NavLink
            to={`/clients/${client.id}`}
            className={({ isActive }: { isActive: boolean }) =>
              ["min-w-0 flex-1 truncate text-[13px] font-medium", isActive ? "text-text" : "text-text-secondary"].join(
                " ",
              )
            }
          >
            {client.name}
          </NavLink>
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
                      <TemplateDot status={tpl.status} ringed={isActive} />
                      <span className="truncate">{tpl.name}</span>
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
