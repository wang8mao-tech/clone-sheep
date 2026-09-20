import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, Settings, TriangleAlert } from "lucide-react";
import { Button } from "../components/ui/Button.js";
import { ConfirmDangerDialog } from "../components/ui/ConfirmDangerDialog.js";
import { InlineNameEditor } from "../components/ui/InlineNameEditor.js";
import { RowMenu } from "../components/ui/RowMenu.js";
import { useToast } from "../components/ui/Toast.js";
import { archiveApi, impactLines, type DeletionImpact, type SidebarClient, type TemplateStatus } from "../lib/archive.js";
import { inlineNameError, useInvalidateArchive } from "../lib/useArchive.js";

export type { SidebarClient, SidebarTemplate } from "../lib/archive.js";

const TEMPLATE_DOT: Record<TemplateStatus, string> = {
  importing: "bg-text-tertiary",
  cloning: "bg-primary animate-pulse",
  awaiting_review: "bg-primary",
  approved: "bg-success",
  failed: "bg-danger",
};

/** 正在就地编辑的那一个。同一时刻只允许一个，省掉多开时的名称冲突判断。 */
type Editing =
  | { kind: "new-client" }
  | { kind: "client"; id: string; name: string }
  | { kind: "template"; id: string; name: string }
  | null;

interface Pending {
  kind: "client" | "template";
  id: string;
  name: string;
  impact: DeletionImpact;
}

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
  const [editing, setEditing] = useState<Editing>(null);
  const [editError, setEditError] = useState<string>();
  const [pending, setPending] = useState<Pending | null>(null);

  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const invalidate = useInvalidateArchive();

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const closeEditor = (): void => {
    setEditing(null);
    setEditError(undefined);
  };

  /** 就地新建 / 改名共用一条出错通道：名称类错误留在框里，其余弹 toast 并收起 */
  const handleNameError = (err: unknown, what: string): void => {
    const inline = inlineNameError(err);
    if (inline) {
      setEditError(inline);
      return;
    }
    toast.push("danger", `${what}失败`, err instanceof Error ? err.message : String(err));
    closeEditor();
  };

  const createClient = useMutation({
    mutationFn: (name: string) => archiveApi.createClient(name),
    onSuccess: (client) => {
      closeEditor();
      invalidate();
      // REQ-001「新建后自动选中」：客户页的路由在 Task 3.3 落，先把树展开
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(client.id);
        return next;
      });
    },
    onError: (err) => handleNameError(err, "新建客户"),
  });

  const rename = useMutation({
    mutationFn: ({ kind, id, name }: { kind: "client" | "template"; id: string; name: string }) =>
      kind === "client" ? archiveApi.renameClient(id, name) : archiveApi.renameTemplate(id, name),
    onSuccess: () => {
      closeEditor();
      invalidate();
    },
    onError: (err) => handleNameError(err, "重命名"),
  });

  const remove = useMutation({
    mutationFn: ({ kind, id }: { kind: "client" | "template"; id: string }) =>
      kind === "client" ? archiveApi.deleteClient(id) : archiveApi.deleteTemplate(id),
    onSuccess: (_impact, { id }) => {
      setPending(null);
      invalidate();
      // 删掉的正是当前打开的对象，就别把用户留在一个已经不存在的页面上
      if (location.pathname.includes(id)) void navigate("/");
    },
    onError: (err) => {
      // REQ-001：删除失败 toast 显示原因，对象保留。关掉弹窗，树上那条还在
      setPending(null);
      toast.push("danger", "删除失败，对象已保留", err instanceof Error ? err.message : String(err));
    },
  });

  /** 先问后端这一刀会砍掉什么，再开弹窗（CMP-012 要列级联影响与将中止的任务数） */
  const askDelete = async (kind: "client" | "template", id: string, name: string): Promise<void> => {
    try {
      const impact = kind === "client" ? await archiveApi.clientImpact(id) : await archiveApi.templateImpact(id);
      setPending({ kind, id, name, impact });
    } catch (err) {
      toast.push("danger", "读取删除影响失败", err instanceof Error ? err.message : String(err));
    }
  };

  const busy = createClient.isPending || rename.isPending;

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
            {clients.map((client) => {
              const open = !collapsed.has(client.id);
              const editingThis = editing?.kind === "client" && editing.id === client.id;

              return (
                <li key={client.id}>
                  {editingThis ? (
                    <InlineNameEditor
                      initialValue={client.name}
                      placeholder="客户名"
                      busy={rename.isPending}
                      error={editError}
                      onCommit={(name) => rename.mutate({ kind: "client", id: client.id, name })}
                      onCancel={closeEditor}
                    />
                  ) : (
                    <div className="group flex h-8 items-center gap-2 px-3 hover:bg-surface-raised">
                      <button
                        type="button"
                        onClick={() => toggle(client.id)}
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
                          {
                            label: "重命名",
                            onSelect: () => {
                              setEditError(undefined);
                              setEditing({ kind: "client", id: client.id, name: client.name });
                            },
                          },
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
                                      TEMPLATE_DOT[tpl.status],
                                      isActive ? "dot-ring" : "",
                                    ].join(" ")}
                                  />
                                  <span className="truncate">{tpl.name}</span>
                                </>
                              )}
                            </NavLink>
                            <div className="absolute top-1/2 right-3 -translate-y-1/2">
                              <RowMenu
                                label={`${tpl.name} 的操作`}
                                items={[
                                  {
                                    label: "重命名",
                                    onSelect: () => {
                                      setEditError(undefined);
                                      setEditing({ kind: "template", id: tpl.id, name: tpl.name });
                                    },
                                  },
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
            })}
          </ul>
        )}

        <div className="px-3 pt-2">
          {editing?.kind === "new-client" ? (
            <InlineNameEditor
              placeholder="客户名"
              busy={createClient.isPending}
              error={editError}
              indentClass="pl-0"
              onCommit={(name) => createClient.mutate(name)}
              onCancel={closeEditor}
            />
          ) : (
            <Button
              variant="ghost"
              icon={<Plus aria-hidden className="size-4" />}
              disabled={busy}
              onClick={() => {
                setEditError(undefined);
                setEditing({ kind: "new-client" });
              }}
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
          <span
            aria-hidden
            className={`inline-block size-2 rounded-full ${healthOk ? "bg-success" : "bg-danger"}`}
          />
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
        onCancel={() => setPending(null)}
      />
    </nav>
  );
}
