import { beforeEach, describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDrawer } from "./AgentDrawer.js";
import { AgentFeedProvider } from "../../lib/AgentFeedProvider.js";
import { renderWithProviders } from "../../test/harness.js";
import { installEventSource, type ControlledEventSource } from "../../test/fake-event-source.js";
import { agentJob, agentMessages as m } from "../../test/agent-fixtures.js";
import { drawerBackend, TPL } from "../../test/agent-drawer-kit.js";

let findSource: ReturnType<typeof installEventSource>;

beforeEach(() => {
  findSource = installEventSource();
});

/** 渲染抽屉并让模板主题那条 SSE 连上（取数只在连上之后开始） */
async function mount(): Promise<ControlledEventSource> {
  renderWithProviders(
    <AgentFeedProvider templateId={TPL}>
      <AgentDrawer />
    </AgentFeedProvider>,
  );
  const es = findSource(`template:${TPL}`);
  if (!es) throw new Error("抽屉没有订阅模板主题");
  act(() => es.open());
  // 拿到任务后主题里加上 job:<id>，EventSource 重建
  const jobSource = await waitFor(() => {
    const s = findSource("job:job-1");
    if (!s) throw new Error("还没订阅任务主题");
    return s;
  });
  act(() => jobSource.open());
  return jobSource;
}

const LONG = "这是一段比较长的 Agent 回复，用来看逐字流式。".repeat(12);

describe("AgentDrawer · 取数顺序与流式", () => {
  it("先订阅再拉：连上之前一个请求都不发；连上后拉快照，拿到任务后订阅 job 主题并对 seq", async () => {
    const { calls } = drawerBackend({ messages: [m.init(1), m.assistant(2, [{ type: "text", text: LONG }])] });
    renderWithProviders(
      <AgentFeedProvider templateId={TPL}>
        <AgentDrawer />
      </AgentFeedProvider>,
    );
    const es = findSource(`template:${TPL}`) as ControlledEventSource;
    expect(calls).toEqual([]);
    act(() => es.open());
    // 快照里的是历史：一出现就是整段，没有光标（不逐字重放）
    const log = await screen.findByRole("log");
    expect(log).toHaveTextContent(LONG);
    expect(screen.queryByTestId("stream-cursor")).toBeNull();
    const jobSource = await waitFor(() => findSource("job:job-1") as ControlledEventSource);
    expect(jobSource.topics).toEqual([`template:${TPL}`, "job:job-1"]);
    expect(es.closed).toBe(true);
    act(() => jobSource.open());
    await waitFor(() => expect(calls).toEqual(["snapshot", "head"]));
  });

  it("AC-009：新消息逐字流式、末尾光标块，流完光标消失；刷新（重新挂载）后历史整段恢复", async () => {
    const { db } = drawerBackend({ messages: [m.init(1)] });
    const es = await mount();
    db.messages.push(m.assistant(2, [{ type: "text", text: LONG }]));
    act(() => es.emit("agent-message", "job:job-1", { jobId: "job-1", seq: 2, type: "assistant" }));
    const cursor = await screen.findByTestId("stream-cursor");
    // 还在流：显示的只是一部分
    expect(cursor.parentElement?.textContent?.length ?? 0).toBeLessThan(LONG.length);
    await waitFor(() => expect(screen.queryByTestId("stream-cursor")).toBeNull(), { timeout: 3000 });
    expect(screen.getByRole("log")).toHaveTextContent(LONG);
  });

  it("断线重连：每次 open 都重拉任务、按游标补齐断线期间的消息", async () => {
    const { db, calls } = drawerBackend({ messages: [m.init(1)] });
    const es = await mount();
    // 断线期间落库，没有任何事件
    db.messages.push(m.assistant(2, [{ type: "text", text: "断线时说的话" }]));
    act(() => es.open());
    expect(await screen.findByText("断线时说的话", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(calls.filter((c) => c.startsWith("after:"))).toEqual(["after:1"]);
  });

  it("截短的页一页页补齐，中间不缺", async () => {
    const { db } = drawerBackend({ messages: [m.init(1)], pageSize: 2 });
    const es = await mount();
    for (let s = 2; s <= 7; s += 1) db.messages.push(m.assistant(s, [{ type: "text", text: `第${s}条` }]));
    act(() => es.emit("agent-message", "job:job-1", { jobId: "job-1", seq: 7, type: "assistant" }));
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("第7条"), { timeout: 3000 });
    for (let s = 2; s <= 7; s += 1) expect(screen.getByRole("log")).toHaveTextContent(`第${s}条`);
  });

  it("往上翻：有更早的消息时给「加载更早的消息」，翻完按钮消失", async () => {
    const user = userEvent.setup();
    const messages = [m.init(1), ...[2, 3, 4].map((s) => m.assistant(s, [{ type: "text", text: `旧${s}` }]))];
    drawerBackend({ messages, pageSize: 2 });
    await mount();
    await screen.findByText("旧4");
    expect(screen.queryByText("旧2")).toBeNull();
    await user.click(screen.getByRole("button", { name: "加载更早的消息" }));
    expect(await screen.findByText("旧2")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "加载更早的消息" })).toBeNull());
  });
});

describe("AgentDrawer · 顶栏", () => {
  it("状态、档案名与模型 id、用时、花费 / 上限、中止；没有「取消任务」", async () => {
    drawerBackend({ job: agentJob({ runElapsedMs: 65_000, runStartedAt: new Date().toISOString() }) });
    await mount();
    const drawer = screen.getByRole("complementary", { name: "Agent 过程" });
    expect(within(drawer).getByText("运行中")).toBeInTheDocument();
    expect(within(drawer).getByText("Claude 订阅 · claude-opus-5")).toBeInTheDocument();
    expect(within(drawer).getByLabelText("用时")).toHaveTextContent(/^1:0[5-7]$/);
    await waitFor(() => expect(within(drawer).getByLabelText("花费与上限")).toHaveTextContent("$0.42 / $5.00 估"));
    expect(within(drawer).getByRole("button", { name: "中止" })).toBeEnabled();
    expect(within(drawer).queryByRole("button", { name: /取消/ })).toBeNull();
  });

  it("中止：调中止接口，顶栏换成「中断」，会话流末尾出结束卡", async () => {
    const user = userEvent.setup();
    const { db } = drawerBackend();
    await mount();
    await user.click(await screen.findByRole("button", { name: "中止" }));
    expect(db.abortCalls).toBe(1);
    const card = await screen.findByRole("status", { name: "结束：中断" });
    expect(card).toHaveTextContent("已手动中止");
    expect(card).toHaveTextContent("用时 1:23");
    expect(card).toHaveTextContent("可以继续（接着同一会话）或重跑");
    expect(screen.queryByRole("button", { name: "中止" })).toBeNull();
  });

  it("中止失败：就地红字给原文", async () => {
    const user = userEvent.setup();
    drawerBackend(
      {},
      { "POST /api/agent-jobs/:id/abort": () => ({ status: 409, body: { error: { message: "任务已经结束" } } }) },
    );
    await mount();
    await user.click(await screen.findByRole("button", { name: "中止" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("中止失败：任务已经结束");
  });

  it("等待额度：蓝灰条写预计恢复时间，用时冻住", async () => {
    const resumeAt = new Date(2026, 8, 23, 14, 20).toISOString();
    drawerBackend({ job: agentJob({ status: "awaiting_quota", resumeAt, runElapsedMs: 30_000 }) });
    await mount();
    expect(await screen.findByText("额度受限 · 预计 14:20 恢复后自动继续")).toBeInTheDocument();
    expect(screen.getByLabelText("用时")).toHaveTextContent("0:30");
  });

  it("没选档案、没指定模型：写「订阅默认模型」", async () => {
    drawerBackend({ job: agentJob({ profileName: null, modelId: null }) });
    await mount();
    expect(await screen.findByText("订阅默认模型")).toBeInTheDocument();
  });
});

describe("AgentDrawer · 思考中计时（复审 S2-L3）", () => {
  it("模型思考时连推 thinking_tokens：「思考中」从最后一条看得见的活动算，不被拨回 0:00", async () => {
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    drawerBackend({
      job: agentJob({ status: "running", runStartedAt: ago(60) }),
      messages: [
        m.init(1, ago(40)),
        m.assistant(2, [{ type: "text", text: "我先想一下" }], ago(30)),
        {
          seq: 3,
          role: null,
          type: "system",
          payload: { type: "system", subtype: "thinking_tokens" },
          createdAt: ago(1),
        },
      ],
    });
    await mount();
    expect(await screen.findByText(/^思考中 · 0:(29|3\d)$/)).toBeInTheDocument();
  });
});

describe("AgentDrawer · 结束卡与空态", () => {
  it("已取消：只说能重跑，不说能继续", async () => {
    drawerBackend({ job: agentJob({ status: "cancelled", stopReason: "user_cancel", runStartedAt: null }) });
    await mount();
    const card = await screen.findByRole("status", { name: "结束：已取消" });
    expect(card).toHaveTextContent("没有会话可继续，只能重跑");
    expect(card).not.toHaveTextContent("继续（");
    expect(card).toHaveTextContent("用时 0:00");
  });

  it("后端崩溃被标中断：用时显示「—」；熔断给原因与花费", async () => {
    drawerBackend({ job: agentJob({ status: "interrupted", stopReason: "backend_restart", runElapsedMs: 0 }) });
    await mount();
    const card = await screen.findByRole("status", { name: "结束：中断" });
    expect(card).toHaveTextContent("后端重启，运行被打断");
    expect(card).toHaveTextContent("用时 —");
    expect(card).toHaveTextContent("花费 $0.42（估）");
  });

  it("熔断：红竖线 + 原因", async () => {
    drawerBackend({ job: agentJob({ status: "tripped", stopReason: "budget：花费达到上限", runElapsedMs: 5_000 }) });
    await mount();
    const card = await screen.findByRole("status", { name: "结束：已熔断" });
    expect(card).toHaveTextContent("超预算：花费达到上限");
    expect(card.querySelector("[data-tone=danger]")).not.toBeNull();
  });

  it("模板没有任务：抽屉收着；展开后说明没有任务，不发任务请求", async () => {
    const user = userEvent.setup();
    const { calls } = drawerBackend({ job: null });
    renderWithProviders(
      <AgentFeedProvider templateId={TPL}>
        <AgentDrawer />
      </AgentFeedProvider>,
    );
    act(() => findSource(`template:${TPL}`)?.open());
    await waitFor(() => expect(calls).toEqual(["snapshot"]));
    await user.click(screen.getByRole("button", { name: "展开 Agent 过程抽屉" }));
    expect(screen.getByText("这个模板还没有 Agent 任务。")).toBeInTheDocument();
    expect(findSource("job:job-1")).toBeUndefined();
  });

  it("模板页之外：只有外壳，不订阅也不请求", async () => {
    const user = userEvent.setup();
    const { calls } = drawerBackend();
    renderWithProviders(
      <AgentFeedProvider templateId={undefined}>
        <AgentDrawer />
      </AgentFeedProvider>,
    );
    await user.click(screen.getByRole("button", { name: "展开 Agent 过程抽屉" }));
    expect(screen.getByText("打开一个模板，这里显示它的 Agent 过程。")).toBeInTheDocument();
    expect(calls).toEqual([]);
  });
});
