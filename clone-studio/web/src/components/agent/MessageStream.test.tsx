import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageStream } from "./MessageStream.js";
import { TodoList } from "./TodoList.js";
import { buildTimeline } from "../../lib/agent-timeline.js";
import type { AgentMessageView } from "../../lib/agent.js";
import { agentMessages as m } from "../../test/agent-fixtures.js";

const T = (s: number) => new Date(Date.parse("2026-09-23T10:00:00.000Z") + s * 1000).toISOString();

function stream(messages: AgentMessageView[], over: Partial<Parameters<typeof MessageStream>[0]> = {}) {
  return render(
    <MessageStream
      items={buildTimeline(messages)}
      liveAfterSeq={Number.MAX_SAFE_INTEGER}
      running={false}
      lastAt={messages.at(-1)?.createdAt ?? null}
      now={Date.parse(T(60))}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={vi.fn()}
      {...over}
    />,
  );
}

const lines = (n: number, tag = "行") => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join("\n");

describe("工具调用折叠行", () => {
  it("一行：工具名 + 参数摘要 + 耗时 + 成败；点开看完整入参与输出，再点收起", async () => {
    const user = userEvent.setup();
    stream([
      m.assistant(1, [m.toolUse("t1", "Bash", { command: "ls -la", description: "列目录" })], T(0)),
      m.toolResult(2, "t1", "a.txt\nb.txt", false, T(3)),
    ]);
    const row = screen.getByRole("button", { name: "Bash ls -la，成功" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveTextContent("ls -la");
    expect(row).toHaveTextContent("0:03");
    expect(within(row).getByRole("img", { name: "成功" })).toBeInTheDocument();
    expect(screen.queryByText("入参")).toBeNull();

    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("入参").nextElementSibling).toHaveTextContent('"description": "列目录"');
    expect(screen.getByText("输出").nextElementSibling).toHaveTextContent("a.txt b.txt");
    await user.click(row);
    expect(screen.queryByText("入参")).toBeNull();
  });

  it("长输出 >12 行折叠、保留首尾，点开看全部", async () => {
    const user = userEvent.setup();
    stream([m.assistant(1, [m.toolUse("t1", "Bash", { command: "seq 30" })]), m.toolResult(2, "t1", lines(30))]);
    await user.click(screen.getByRole("button", { name: /Bash/ }));
    const out = screen.getByText("输出").nextElementSibling as HTMLElement;
    expect(out).toHaveTextContent("行1");
    expect(out).toHaveTextContent("行30");
    expect(out).not.toHaveTextContent("行15");
    await user.click(within(out).getByRole("button", { name: "… 省略 18 行，展开全部 30 行" }));
    expect(out).toHaveTextContent("行15");
  });

  it("写文件的行点开：内容按代码块显示（高亮、可折叠），不是转义成一行的 JSON", async () => {
    const user = userEvent.setup();
    stream([
      m.assistant(1, [m.toolUse("t1", "Write", { file_path: "TIMELINE.md", content: "# 时间线\n\n- 0:00 开场" })]),
      m.toolResult(2, "t1", "ok"),
    ]);
    await user.click(screen.getByRole("button", { name: /Write TIMELINE\.md/ }));
    expect(screen.getByText("内容")).toBeInTheDocument();
    expect(document.querySelector("code.language-markdown")).toHaveTextContent("# 时间线");
    expect(screen.queryByText(/\\n/)).toBeNull();
  });

  it("12 行以内不折叠", async () => {
    const user = userEvent.setup();
    stream([m.assistant(1, [m.toolUse("t1", "Bash", { command: "seq 12" })]), m.toolResult(2, "t1", lines(12))]);
    await user.click(screen.getByRole("button", { name: /Bash/ }));
    expect(screen.queryByRole("button", { name: /省略/ })).toBeNull();
  });

  it("任务在跑、工具没回结果：转圈 + 已用时长，不显示「思考中」；任务停了标「未完成」", () => {
    const msgs = [m.assistant(1, [m.toolUse("t1", "Bash", { command: "sleep 99" })], T(0))];
    const { rerender } = stream(msgs, { running: true, now: Date.parse(T(42)) });
    const row = screen.getByRole("button", { name: /Bash/ });
    expect(within(row).getByRole("img", { name: "运行中" })).toBeInTheDocument();
    expect(row).toHaveTextContent("0:42");
    expect(screen.queryByText(/思考中/)).toBeNull();
    rerender(
      <MessageStream
        items={buildTimeline(msgs)}
        liveAfterSeq={0}
        running={false}
        lastAt={T(0)}
        now={Date.parse(T(42))}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Bash/ })).toHaveTextContent("未完成");
  });
});

describe("贴底跟随", () => {
  it("新消息来了跟到底；只是秒表走了（重渲染）不拽滚动条，展开上面的行不会被拉回底部", () => {
    const base = [m.init(1, T(0)), m.assistant(2, [{ type: "text", text: "一" }], T(1))];
    // 抽屉里 items 按 messages 记忆（useMemo），秒表走不会换一份新数组；这里照样复用
    const baseItems = buildTimeline(base);
    const props = (msgs: AgentMessageView[], now: number) => ({
      items: msgs === base ? baseItems : buildTimeline(msgs),
      liveAfterSeq: Number.MAX_SAFE_INTEGER,
      running: true,
      lastAt: T(1),
      now,
      hasOlder: false,
      loadingOlder: false,
      onLoadOlder: vi.fn(),
    });
    const { rerender } = render(<MessageStream {...props(base, Date.parse(T(2)))} />);
    const log = screen.getByRole("log");
    // jsdom 没有布局：手动给出「内容比视口高」
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 100 });
    log.scrollTop = 500;
    rerender(<MessageStream {...props(base, Date.parse(T(3)))} />);
    expect(log.scrollTop).toBe(500);
    rerender(
      <MessageStream {...props([...base, m.assistant(3, [{ type: "text", text: "二" }], T(3))], Date.parse(T(3)))} />,
    );
    expect(log.scrollTop).toBe(1000);
  });
});

describe("红 / 琥珀竖线", () => {
  it("失败的工具红、被拦截的工具与拦截记录琥珀、错误结束红，正常的不画线", () => {
    stream([
      m.assistant(1, [
        m.toolUse("ok", "Read", { file_path: "a.md" }),
        m.toolUse("bad", "Bash", { command: "false" }),
        m.toolUse("blocked", "Bash", { command: "hypit build" }),
      ]),
      m.toolResult(2, "ok", "内容"),
      m.toolResult(3, "bad", "exit 1", true),
      m.toolResult(4, "blocked", "已拦截：出片由宿主负责", true),
      m.intercept(5, "hypit build --out x"),
      m.result(6, "error_max_budget_usd"),
    ]);
    const toneOf = (el: HTMLElement) => el.closest("[data-tone]")?.getAttribute("data-tone") ?? null;
    expect(toneOf(screen.getByRole("button", { name: /a\.md/ }))).toBeNull();
    expect(toneOf(screen.getByRole("button", { name: /false/ }))).toBe("danger");
    const blocked = screen.getByRole("button", { name: "Bash hypit build，已拦截" });
    expect(toneOf(blocked)).toBe("warning");
    expect(within(blocked).getByRole("img", { name: "已拦截" })).toBeInTheDocument();
    const intercept = screen.getByText("已拦截：出片由宿主负责");
    expect(toneOf(intercept)).toBe("warning");
    expect(intercept.parentElement).toHaveTextContent("Bash · hypit build --out x");
    expect(toneOf(screen.getByText("花费达到上限"))).toBe("danger");
  });
});

describe("思考、提示与分隔", () => {
  it("思考默认折叠成一行「思考 · 8s」，点开看全文", async () => {
    const user = userEvent.setup();
    stream([m.init(1, T(0)), m.assistant(2, [{ type: "thinking", thinking: "先看帧再写时间线" }], T(8))]);
    const toggle = screen.getByRole("button", { name: "思考 · 8s" });
    expect(screen.queryByText("先看帧再写时间线")).toBeNull();
    await user.click(toggle);
    expect(screen.getByText("先看帧再写时间线")).toBeInTheDocument();
  });

  it("运行中、没有在跑的工具：末尾一行「思考中」从最后一条消息起计时", () => {
    stream([m.init(1, T(0)), m.assistant(2, [{ type: "text", text: "好" }], T(10))], {
      running: true,
      now: Date.parse(T(25)),
    });
    expect(screen.getByText("思考中 · 0:15")).toBeInTheDocument();
  });

  it("系统代发的任务提示左侧细竖线；继续运行前一条分隔线", () => {
    stream([m.prompt(1, "start", "复刻这条视频"), m.init(2), m.prompt(3, "continue", "字幕换成黄色")]);
    expect(screen.getByText("复刻这条视频").parentElement).toHaveClass("border-l-2");
    expect(screen.getByRole("separator")).toHaveTextContent("继续运行");
    expect(screen.getByText("字幕换成黄色")).toBeInTheDocument();
  });

  it("任务提示超过 4 行先收起，点开看全部", async () => {
    const user = userEvent.setup();
    stream([m.prompt(1, "start", lines(9, "要求"))]);
    expect(screen.getByText(/要求4/)).not.toHaveTextContent("要求5");
    await user.click(screen.getByRole("button", { name: "展开全部 9 行" }));
    expect(screen.getByText(/要求9/)).toBeInTheDocument();
  });

  it("宿主停下的那一段：收尾 result 画成中性一行并写原因，不是红块；限流单说", () => {
    stream([
      m.assistant(1, [{ type: "text", text: "一" }]),
      m.result(2, "error_during_execution"),
      m.stop(3, "user_abort"),
      m.prompt(4, "continue", "继续"),
      m.stop(5, "awaiting_quota"),
    ]);
    expect(screen.getByText("— 会话在这里被停下：已手动中止 —")).toBeInTheDocument();
    expect(screen.getByText("— 会话在这里被停下：额度受限，等恢复后续跑 —")).toBeInTheDocument();
    expect(screen.queryByText("会话执行出错")).toBeNull();
    expect(document.querySelector("[data-tone]")).toBeNull();
  });
});

describe("markdown", () => {
  it("渲染 markdown；代码块 >20 行默认折叠，点开看全部", async () => {
    const user = userEvent.setup();
    const code = "```js\n" + lines(25, "const a") + "\n```";
    stream([m.assistant(1, [{ type: "text", text: `## 标题\n\n**加粗**\n\n${code}` }])]);
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(screen.getByText("加粗").tagName).toBe("STRONG");
    const pre = document.querySelector("pre") as HTMLElement;
    expect(pre).toHaveAttribute("data-folded", "true");
    await user.click(screen.getByRole("button", { name: "展开全部 25 行" }));
    expect(pre).not.toHaveAttribute("data-folded");
    expect(screen.getByRole("button", { name: "收起代码" })).toBeInTheDocument();
  });

  it("20 行以内的代码块不折叠", () => {
    stream([m.assistant(1, [{ type: "text", text: "```\n" + lines(20) + "\n```" }])]);
    expect(document.querySelector("pre")).not.toHaveAttribute("data-folded");
    expect(screen.queryByRole("button", { name: /展开全部/ })).toBeNull();
  });
});

describe("待办清单", () => {
  it("逐项显示进度：完成划线、进行中显示进行时文案；可收起成一行", async () => {
    const user = userEvent.setup();
    render(
      <TodoList
        todos={[
          { content: "看帧", status: "completed" },
          { content: "写时间线", status: "in_progress", activeForm: "正在写时间线" },
          { content: "跑 check", status: "pending" },
        ]}
        running
      />,
    );
    const list = screen.getByRole("region", { name: "待办" });
    expect(within(list).getByRole("button")).toHaveTextContent("待办 1/3");
    expect(within(list).getByRole("listitem", { name: "看帧：已完成" })).toHaveTextContent("看帧");
    expect(within(list).getByText("看帧")).toHaveClass("line-through");
    expect(within(list).getByRole("listitem", { name: "写时间线：进行中" })).toHaveTextContent("正在写时间线");
    expect(within(list).getByRole("listitem", { name: "跑 check：未开始" })).toBeInTheDocument();
    await user.click(within(list).getByRole("button"));
    expect(within(list).queryByRole("listitem")).toBeNull();
    expect(within(list).getByRole("button")).toHaveTextContent("正在写时间线");
  });
});
