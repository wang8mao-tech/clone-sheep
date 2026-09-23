import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  lastActivityAt,
  latestTodos,
  summarizeInput,
  toneOf,
  type TimelineItem,
} from "./agent-timeline.js";
import type { AgentMessageView } from "./agent.js";
import { agentMessages as m } from "../test/agent-fixtures.js";

const kinds = (items: TimelineItem[]) => items.map((i) => i.kind);

describe("buildTimeline", () => {
  it("assistant 的 text / thinking / tool_use 各成一个单元，tool_result 挂回对应的工具行", () => {
    const items = buildTimeline([
      m.init(1),
      m.assistant(2, [
        { type: "thinking", thinking: "先看看目录" },
        { type: "text", text: "我先列一下文件。" },
        m.toolUse("t1", "Bash", { command: "ls -la" }),
      ]),
      m.toolResult(3, "t1", "a\nb"),
    ]);
    expect(kinds(items)).toEqual(["thinking", "text", "tool"]);
    const tool = items[2];
    expect(tool).toMatchObject({
      kind: "tool",
      name: "Bash",
      result: { text: "a\nb", isError: false, intercepted: false },
    });
  });

  it("思考的秒数取它和上一条消息的间隔", () => {
    const items = buildTimeline([
      m.init(1, "2026-09-23T10:00:00.000Z"),
      m.assistant(2, [{ type: "thinking", thinking: "嗯" }], "2026-09-23T10:00:08.000Z"),
    ]);
    expect(items[0]).toMatchObject({ kind: "thinking", seconds: 8 });
  });

  it("思考秒数不被中间连推的进度消息（thinking_tokens）拨短（复审 S2-L4）", () => {
    const items = buildTimeline([
      m.init(1, "2026-09-23T10:00:00.000Z"),
      {
        seq: 2,
        role: null,
        type: "system",
        payload: { type: "system", subtype: "thinking_tokens" },
        createdAt: "2026-09-23T10:00:07.000Z",
      },
      m.assistant(3, [{ type: "thinking", thinking: "嗯" }], "2026-09-23T10:00:08.000Z"),
    ]);
    expect(items[0]).toMatchObject({ kind: "thinking", seconds: 8 });
  });

  it("宿主记的任务提示：第一次成用户消息；人点继续先分隔再给那句话；自动续跑只分隔", () => {
    const items = buildTimeline([
      m.prompt(1, "start", "复刻这条视频"),
      m.init(2),
      m.prompt(3, "continue", "字幕换成黄色"),
      m.init(4),
      m.prompt(5, "auto_resume", "继续完成之前的任务"),
      m.init(6),
    ]);
    expect(items.map((i) => [i.kind, i.kind === "prompt" ? i.text : i.kind === "divider" ? i.label : ""])).toEqual([
      ["prompt", "复刻这条视频"],
      ["divider", "继续运行"],
      ["prompt", "字幕换成黄色"],
      ["divider", "额度恢复，自动继续"],
    ]);
  });

  it("SDK 的 user 消息里只取工具结果：文字内容（技能注入之类）不当成任务提示", () => {
    const items = buildTimeline([
      {
        seq: 1,
        role: "user",
        type: "user",
        payload: { type: "user", message: { content: "Base directory for this skill" } },
        createdAt: "x",
      },
    ]);
    expect(items).toEqual([]);
  });

  it("宿主停下的段：这一段收尾的 result 红块换成中性一行（带原因），每一段都认；不看 result 长什么样", () => {
    const items = buildTimeline([
      m.assistant(1, [{ type: "text", text: "一" }]),
      // result 里带了 errors 也一样：认的是宿主的记录，不猜 SDK 的字段
      m.result(2, "error_during_execution"),
      m.stop(3, "user_abort"),
      m.prompt(4, "continue", "继续"),
      m.assistant(5, [{ type: "text", text: "二" }]),
      m.result(6, "error_max_budget_usd"),
      m.stop(7, "budget：花费达到上限"),
    ]);
    expect(kinds(items)).toEqual(["text", "stopped", "divider", "prompt", "text", "stopped"]);
    expect(items.filter((i) => i.kind === "stopped").map((i) => i.kind === "stopped" && i.reason)).toEqual([
      "user_abort",
      "budget：花费达到上限",
    ]);
    expect(items.every((i) => toneOf(i) === null)).toBe(true);
  });

  it("没有宿主停下记录的出错 result 照常红块；停下记录找不到 result 时自己画一行，不去动上一段", () => {
    expect(kinds(buildTimeline([m.result(1, "error_during_execution")]))).toEqual(["error"]);
    const items = buildTimeline([
      m.result(1, "error_during_execution"),
      m.prompt(2, "continue", "继续"),
      m.stop(3, "user_cancel"),
    ]);
    expect(kinds(items)).toEqual(["error", "divider", "prompt", "stopped"]);
  });

  it("宿主拦截记录成琥珀块；被 hook 拒掉的工具结果标「已拦截」而不是失败", () => {
    const items = buildTimeline([
      m.assistant(1, [m.toolUse("t1", "Bash", { command: "hypit build" })]),
      m.intercept(2, "hypit build"),
      m.toolResult(3, "t1", "已拦截：出片由宿主负责。不要换写法重试。", true),
    ]);
    expect(kinds(items)).toEqual(["tool", "intercept"]);
    expect(items[0]).toMatchObject({ result: { isError: true, intercepted: true } });
    expect(items[1]).toMatchObject({ rule: "hypit-command", detail: "hypit build" });
  });

  it("以错误结束的 result 成红块，成功的 result 不单独显示（结束卡会说）", () => {
    const items = buildTimeline([m.result(1, "error_max_budget_usd"), m.result(2, "success")]);
    expect(items).toEqual([expect.objectContaining({ kind: "error", title: "花费达到上限" })]);
  });

  it("坏消息与认不出的类型：坏的显示原文，认不出的跳过，都不让时间线崩", () => {
    const items = buildTimeline([
      { seq: 1, role: null, type: "assistant", payload: { type: "unparsable", raw: "{oops" }, createdAt: "x" },
      { seq: 2, role: null, type: "stream_event", payload: { type: "stream_event" }, createdAt: "x" },
      { seq: 3, role: null, type: "assistant", payload: null, createdAt: "x" },
      m.toolResult(4, "nope", "孤儿结果"),
    ]);
    expect(items).toEqual([expect.objectContaining({ kind: "error", detail: "{oops" })]);
  });

  it("工具结果内容是块数组时拼成文字，非文字块给占位", () => {
    const items = buildTimeline([
      m.assistant(1, [m.toolUse("t1", "Read", { file_path: "a.png" })]),
      {
        seq: 2,
        role: "user",
        type: "user",
        payload: {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "看图" }, { type: "image" }] },
            ],
          },
        },
        createdAt: "2026-09-23T10:00:01.000Z",
      },
    ]);
    expect(items[0]).toMatchObject({ result: { text: "看图\n[image]" } });
  });
});

describe("toneOf：红 / 琥珀竖线", () => {
  const items = buildTimeline([
    m.assistant(1, [
      m.toolUse("ok", "Bash", { command: "ls" }),
      m.toolUse("bad", "Bash", { command: "false" }),
      m.toolUse("blocked", "Bash", { command: "hypit build" }),
      m.toolUse("pending", "Bash", { command: "sleep 9" }),
      { type: "text", text: "文字" },
    ]),
    m.toolResult(2, "ok", "fine"),
    m.toolResult(3, "bad", "exit 1", true),
    m.toolResult(4, "blocked", "已拦截：出片由宿主负责", true),
    m.intercept(5, "hypit build"),
    m.result(6, "error_during_execution"),
  ]);
  const byKey = (pred: (i: TimelineItem) => boolean) => toneOf(items.find(pred) as TimelineItem);
  const tool = (id: string) => (i: TimelineItem) => i.kind === "tool" && i.id === id;

  it("失败的工具与错误结束红，拦截琥珀，其余不画线", () => {
    expect(byKey(tool("ok"))).toBeNull();
    expect(byKey(tool("pending"))).toBeNull();
    expect(byKey(tool("bad"))).toBe("danger");
    expect(byKey(tool("blocked"))).toBe("warning");
    expect(byKey((i) => i.kind === "intercept")).toBe("warning");
    expect(byKey((i) => i.kind === "error")).toBe("danger");
    expect(byKey((i) => i.kind === "text")).toBeNull();
  });
});

describe("lastActivityAt：「思考中」的计时起点", () => {
  it("跳过 thinking_tokens、rate_limit_event 这类看不见的进度消息；init 算一次活动", () => {
    const progress = (seq: number, createdAt: string): AgentMessageView => ({
      seq,
      role: null,
      type: "system",
      payload: { type: "system", subtype: "thinking_tokens" },
      createdAt,
    });
    const msgs: AgentMessageView[] = [
      m.assistant(1, [{ type: "text", text: "先看目录" }], "2026-09-23T10:00:00.000Z"),
      m.init(2, "2026-09-23T10:00:05.000Z"),
      progress(3, "2026-09-23T10:00:20.000Z"),
      {
        seq: 4,
        role: null,
        type: "rate_limit_event",
        payload: { type: "rate_limit_event" },
        createdAt: "2026-09-23T10:00:25.000Z",
      },
      progress(5, "2026-09-23T10:00:30.000Z"),
    ];
    expect(lastActivityAt(msgs)).toBe("2026-09-23T10:00:05.000Z");
    expect(lastActivityAt(msgs.slice(0, 1))).toBe("2026-09-23T10:00:00.000Z");
    expect(lastActivityAt([progress(1, "x")])).toBeNull();
  });
});

describe("latestTodos", () => {
  it("取最近一次 TodoWrite 的整份清单；没调过给 null", () => {
    const todos = (list: unknown[]) => m.toolUse("x", "TodoWrite", { todos: list });
    const msgs: AgentMessageView[] = [
      m.assistant(1, [todos([{ content: "旧", status: "pending" }])]),
      m.assistant(2, [
        todos([
          { content: "看帧", status: "completed" },
          { content: "写时间线", status: "in_progress", activeForm: "正在写时间线" },
          { content: "跑 check", status: "weird" },
        ]),
      ]),
      m.assistant(3, [{ type: "text", text: "继续" }]),
    ];
    expect(latestTodos(msgs)).toEqual([
      { content: "看帧", status: "completed" },
      { content: "写时间线", status: "in_progress", activeForm: "正在写时间线" },
      { content: "跑 check", status: "pending" },
    ]);
    expect(latestTodos([m.init(1)])).toBeNull();
  });
});

describe("summarizeInput", () => {
  it("挑最能说明在干什么的参数，压成一行", () => {
    expect(summarizeInput("Bash", { command: "ls\n  -la", description: "列目录" })).toBe("ls -la");
    expect(summarizeInput("Read", { file_path: "C:/w/ANALYSIS.md" })).toBe("C:/w/ANALYSIS.md");
    expect(summarizeInput("TodoWrite", { todos: [1, 2, 3] })).toBe("3 项");
    expect(summarizeInput("Mystery", { n: 1 })).toBe('{"n":1}');
    expect(summarizeInput("Mystery", null)).toBe("");
  });
});
