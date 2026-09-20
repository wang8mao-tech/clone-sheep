import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { useToast } from "../components/ui/Toast.js";
import { archiveApi, type DeletionImpact } from "../lib/archive.js";
import { inlineNameError, useInvalidateArchive } from "../lib/useArchive.js";

/** 正在就地编辑的那一个。同一时刻只允许一个，省掉多开时的名称冲突判断。 */
export type Editing =
  | { kind: "new-client" }
  | { kind: "client"; id: string; name: string }
  | { kind: "template"; id: string; name: string }
  | null;

export interface PendingDeletion {
  kind: "client" | "template";
  id: string;
  name: string;
  impact: DeletionImpact;
}

/**
 * 归档的三个动作：就地新建、就地改名、级联删除。
 *
 * 抽出来是因为这三件事各自都带着"编辑态 + 错误分流 + 失效重拉"的一整套编排，
 * 全塞在 Sidebar 里会让那个组件同时管树渲染、折叠状态和三条异步流程。
 * 首页的「新建客户」（Task 3.3）也要用同一套。
 */
export function useArchiveActions(onCreated?: (clientId: string) => void) {
  const [editing, setEditing] = useState<Editing>(null);
  const [editError, setEditError] = useState<string>();
  const [pending, setPending] = useState<PendingDeletion | null>(null);

  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const invalidate = useInvalidateArchive();

  const closeEditor = (): void => {
    setEditing(null);
    setEditError(undefined);
  };

  const beginEdit = (next: NonNullable<Editing>): void => {
    setEditError(undefined);
    setEditing(next);
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
      onCreated?.(client.id);
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

  return {
    editing,
    editError,
    pending,
    beginEdit,
    closeEditor,
    clearEditError: () => setEditError(undefined),
    cancelDelete: () => setPending(null),
    createClient,
    rename,
    remove,
    askDelete,
    busy: createClient.isPending || rename.isPending,
  };
}
