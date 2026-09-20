import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { useArchiveActions } from "../app/useArchiveActions.js";
import { Button } from "../components/ui/Button.js";
import { InlineNameEditor } from "../components/ui/InlineNameEditor.js";
import { archiveApi, archiveKeys } from "../lib/archive.js";

/**
 * SCREEN-002 首页：居中一句话 + 一个主按钮，不放插画（Design-Brief 5.5）。
 *
 * 有客户时说的是另一句话——之前这里恒显示「还没有客户」，哪怕侧栏里站着三个，
 * 用户第一眼看到的就是一句假话。
 */
export function HomePage() {
  const navigate = useNavigate();
  // 建完直接进那个客户的页面（REQ-001「新建后自动选中」）
  const actions = useArchiveActions((clientId) => void navigate(`/clients/${clientId}`));
  const { editing, editError, beginEdit, closeEditor, clearEditError, createClient } = actions;

  const clients = useQuery({
    queryKey: archiveKeys.clients,
    queryFn: () => archiveApi.listClients(),
  });

  const count = clients.data?.clients.length ?? 0;
  const adding = editing?.kind === "new-client";

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-80 flex-col items-center gap-4">
        {/* 拿不到列表时绝不能说「还没有客户」——用户手上可能有二十个，
            只是后端没应答。这正是这个页面上一版犯的错，换个触发条件而已 */}
        <p className="text-center text-[13px] text-text-secondary">
          {clients.isError
            ? "读不到客户列表，后端可能没在跑。"
            : clients.isLoading
              ? "　"
              : count === 0
                ? "还没有客户。建一个客户，再往里加参考视频。"
                : "从左侧选一个客户，或者再建一个。"}
        </p>

        {clients.isError ? (
          <Button variant="secondary" onClick={() => void clients.refetch()} loading={clients.isFetching}>
            重试
          </Button>
        ) : adding ? (
          <div className="w-full">
            <InlineNameEditor
              placeholder="客户名"
              busy={createClient.isPending}
              error={editError}
              indentClass="pl-0"
              onDirty={clearEditError}
              onCommit={(name) => createClient.mutate(name)}
              onCancel={closeEditor}
            />
          </div>
        ) : (
          <Button
            variant="primary"
            icon={<Plus aria-hidden className="size-4" />}
            disabled={actions.busy}
            onClick={() => beginEdit({ kind: "new-client" })}
          >
            新建客户
          </Button>
        )}
      </div>
    </div>
  );
}
