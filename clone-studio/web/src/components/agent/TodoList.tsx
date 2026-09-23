import { useState } from "react";
import { ChevronRight, Circle, CircleCheck, CircleDot } from "lucide-react";
import type { TodoEntry } from "../../lib/agent-timeline.js";

/**
 * 待办清单：常驻抽屉顶栏下方，勾选随进度更新（Design-Brief §A.2）。
 * 数据是 Agent 最近一次 TodoWrite 的入参。可以收起，收起时只留一行进度。
 */
/** `running`：任务在跑时「进行中」那一项才脉动；停下之后它就只是「停在这一步」 */
export function TodoList({ todos, running }: { todos: TodoEntry[]; running: boolean }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");

  return (
    <section aria-label="待办" className="border-b border-border px-3 py-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-7 w-full min-w-0 items-center gap-2 text-left text-caption text-text-secondary hover:text-text"
      >
        <ChevronRight
          aria-hidden
          className={["size-3.5 shrink-0 transition-transform", open ? "rotate-90" : ""].join(" ")}
        />
        <span className="shrink-0">
          待办 {done}/{todos.length}
        </span>
        {!open && current ? (
          <span className="min-w-0 truncate text-text-tertiary">{current.activeForm ?? current.content}</span>
        ) : null}
      </button>
      {open ? (
        <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto">
          {todos.map((t, i) => (
            <li
              key={`${i}-${t.content}`}
              aria-label={`${t.content}：${STATE_LABEL[t.status]}`}
              className="flex min-w-0 items-start gap-2"
            >
              <TodoIcon status={t.status} running={running} />
              <span
                className={[
                  "min-w-0",
                  t.status === "completed" ? "text-text-tertiary line-through" : "",
                  t.status === "in_progress" ? "text-text" : "text-text-secondary",
                ].join(" ")}
              >
                {t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const STATE_LABEL: Record<TodoEntry["status"], string> = {
  pending: "未开始",
  in_progress: "进行中",
  completed: "已完成",
};

function TodoIcon({ status, running }: { status: TodoEntry["status"]; running: boolean }) {
  const cls = "mt-[0.2em] size-3.5 shrink-0";
  if (status === "completed") return <CircleCheck aria-hidden className={`${cls} text-success`} />;
  if (status === "in_progress")
    return <CircleDot aria-hidden className={`${cls} text-primary ${running ? "animate-pulse" : ""}`} />;
  return <Circle aria-hidden className={`${cls} text-text-tertiary`} />;
}
