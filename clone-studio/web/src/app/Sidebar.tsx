import { useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { Plus, Settings, TriangleAlert } from "lucide-react";
import { ClientNode } from "./ClientNode.js";
import { useArchiveActions } from "./useArchiveActions.js";
import { Button } from "../components/ui/Button.js";
import { ConfirmDangerDialog } from "../components/ui/ConfirmDangerDialog.js";
import { InlineNameEditor } from "../components/ui/InlineNameEditor.js";
import { impactLines, type SidebarClient } from "../lib/archive.js";

export type { SidebarClient, SidebarTemplate } from "../lib/archive.js";

interface Props {
  clients: SidebarClient[];
  loading: boolean;
  /** 后端未响应时侧栏顶部红色细条 + 重试（SCREEN-001） */
  error?: string;
  onRetry: () => void;
  healthOk: boolean;
}

export function Sidebar({ clients, loading, error, onRetry, healthOk }: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const navigate = useNavigate();

  const setOpen = (id: string, open: boolean): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // REQ-001「新建后自动选中」：展开新客户的枝，并进它的客户页。
  // 首页那个入口也是这个行为——同一个动作两个入口，结果必须一致
  const actions = useArchiveActions((clientId) => {
    setOpen(clientId, true);
    void navigate(`/clients/${clientId}`);
  });
  const { editing, editError, pending, beginEdit, closeEditor, clearEditError, cancelDelete, createClient, remove } =
    actions;

  return (
    <nav
      aria-label="客户与模板"
      className="flex h-full w-[var(--shell-sidebar-width)] shrink-0 flex-col border-r border-border bg-surface"
    >
      {error ? (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-3 py-1.5">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-danger" />
          <span className="flex-1 truncate text-caption text-danger" title={error}>
            {error}
          </span>
          <button type="button" onClick={onRetry} className="text-caption text-danger underline">
            重试
          </button>
        </div>
      ) : null}

      <div className="flex h-[var(--shell-topbar-height)] items-center gap-2.5 border-b border-border px-4">
        <span aria-hidden className="inline-block size-[18px] rounded-sm bg-primary" />
        <span className="text-[14px] font-semibold">Clone Studio</span>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <ul className="flex flex-col gap-1 px-3" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="h-[var(--row-height)] animate-pulse rounded-md bg-surface-raised" />
            ))}
          </ul>
        ) : clients.length === 0 ? null : (
          <ul className="flex flex-col">
            {clients.map((client) => (
              <ClientNode
                key={client.id}
                client={client}
                open={!collapsed.has(client.id)}
                onToggle={() => setOpen(client.id, collapsed.has(client.id))}
                actions={actions}
              />
            ))}
          </ul>
        )}

        <div className="px-3 pt-2">
          {editing?.kind === "new-client" ? (
            <InlineNameEditor
              placeholder="客户名"
              busy={createClient.isPending}
              error={editError}
              indentClass="pl-0"
              onDirty={clearEditError}
              onCommit={(name) => createClient.mutate(name)}
              onCancel={closeEditor}
            />
          ) : (
            <Button
              variant="ghost"
              icon={<Plus aria-hidden className="size-4" />}
              // 后端没应答时一并禁掉：首页那个入口也是禁的，
              // 同一个动作两个入口，结果必须一致
              disabled={actions.busy || Boolean(error)}
              disabledReason={error ? "后端没应答，先重试" : undefined}
              onClick={() => beginEdit({ kind: "new-client" })}
            >
              新客户
            </Button>
          )}
        </div>
      </div>

      <div className="border-t border-border p-2">
        <NavLink
          to="/settings"
          className={({ isActive }: { isActive: boolean }) =>
            [
              "flex h-8 items-center gap-2 rounded-md px-2 text-[13px]",
              isActive ? "bg-surface-raised text-text" : "text-text-secondary hover:bg-surface-raised",
            ].join(" ")
          }
        >
          <Settings aria-hidden className="size-4" />
          <span className="flex-1">设置</span>
          <span aria-hidden className={`inline-block size-2 rounded-full ${healthOk ? "bg-success" : "bg-danger"}`} />
          <span className="sr-only">{healthOk ? "体检通过" : "体检未通过"}</span>
        </NavLink>
      </div>

      <ConfirmDangerDialog
        open={pending !== null}
        title={pending?.kind === "client" ? `删除客户「${pending.name}」` : `删除模板「${pending?.name ?? ""}」`}
        confirmName={pending?.name ?? ""}
        impacts={pending ? impactLines(pending.impact) : []}
        busy={remove.isPending}
        onConfirm={() => {
          if (pending) remove.mutate({ kind: pending.kind, id: pending.id });
        }}
        onCancel={cancelDelete}
      />
    </nav>
  );
}
