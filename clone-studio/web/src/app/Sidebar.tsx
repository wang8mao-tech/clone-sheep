import { useState } from "react";
import { NavLink } from "react-router";
import { ChevronDown, ChevronRight, Plus, Settings, TriangleAlert } from "lucide-react";
import { Button } from "../components/ui/Button.js";

export interface SidebarTemplate {
  id: string;
  name: string;
  status: "importing" | "cloning" | "awaiting_review" | "approved" | "failed";
}

export interface SidebarClient {
  id: string;
  name: string;
  templates: SidebarTemplate[];
}

const TEMPLATE_DOT: Record<SidebarTemplate["status"], string> = {
  importing: "bg-text-tertiary",
  cloning: "bg-primary animate-pulse",
  awaiting_review: "bg-primary",
  approved: "bg-success",
  failed: "bg-danger",
};

interface Props {
  clients: SidebarClient[];
  loading: boolean;
  /** 后端未响应时侧栏顶部红色细条 + 重试（SCREEN-001） */
  error?: string;
  onRetry: () => void;
  onNewClient: () => void;
  healthOk: boolean;
}

export function Sidebar({ clients, loading, error, onRetry, onNewClient, healthOk }: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
              return (
                <li key={client.id}>
                  <button
                    type="button"
                    onClick={() => toggle(client.id)}
                    aria-expanded={open}
                    className="flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] font-medium hover:bg-surface-raised"
                  >
                    {open ? (
                      <ChevronDown aria-hidden className="size-3.5 text-text-tertiary" />
                    ) : (
                      <ChevronRight aria-hidden className="size-3.5 text-text-tertiary" />
                    )}
                    <span className="truncate">{client.name}</span>
                  </button>

                  {open ? (
                    <ul className="flex flex-col">
                      {client.templates.map((tpl) => (
                        <li key={tpl.id}>
                          <NavLink
                            to={`/clients/${client.id}/templates/${tpl.id}`}
                            className={({ isActive }: { isActive: boolean }) =>
                              [
                                "mx-1.5 flex h-8 items-center gap-2 rounded-md pr-3 pl-[26px] text-[13px]",
                                isActive ? "bg-surface-raised text-text" : "text-text-secondary hover:bg-surface-raised",
                              ].join(" ")
                            }
                          >
                            <span
                              aria-hidden
                              className={`inline-block size-2 shrink-0 rounded-full ${TEMPLATE_DOT[tpl.status]}`}
                            />
                            <span className="truncate">{tpl.name}</span>
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <div className="px-3 pt-2">
          <Button variant="ghost" icon={<Plus aria-hidden className="size-4" />} onClick={onNewClient}>
            新客户
          </Button>
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
    </nav>
  );
}
