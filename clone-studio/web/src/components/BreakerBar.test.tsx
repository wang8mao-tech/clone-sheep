import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BreakerBar } from "./BreakerBar.js";
import { AgentDrawer } from "./agent/AgentDrawer.js";
import { AgentFeedProvider } from "../lib/AgentFeedProvider.js";
import type { AgentJobStatus } from "../lib/agent.js";
import { renderWithProviders, stubFetch } from "../test/harness.js";
import { installEventSource } from "../test/fake-event-source.js";
import { agentJob } from "../test/agent-fixtures.js";
import { drawerBackend, TPL } from "../test/agent-drawer-kit.js";

/** CMP-009 熔断 / 中断横条：出不出、出哪些按钮、继续 / 重跑怎么调、失败怎么显示、和抽屉是不是同一份数据 */

let findSource: ReturnType<typeof installEventSource>;
beforeEach(() => {
  findSource = installEventSource();
});

/** 横条与抽屉挂在同一个 Provider 下，和外壳里一样；连上模板主题的 SSE 才开始取数 */
async function mount(withDrawer = false) {
  renderWithProviders(
    <AgentFeedProvider templateId={TPL}>
      <BreakerBar />
      {withDrawer ? <AgentDrawer /> : null}
    </AgentFeedProvider>,
  );
  act(() => findSource(`template:${TPL}`)?.open());
  await waitFor(() => {
    if (!findSource("job:job-1")) throw new Error("还没拿到任务");
  });
}

const bar = () => screen.queryByRole("status", { name: /^任务/ });

describe("什么时候出横条、出哪些按钮", () => {
  it.each([
    ["tripped", "已熔断", true, ["继续", "重跑"], "timeout：运行超过 45 分钟"],
    ["failed", "失败", true, ["继续", "重跑"], "会话没有返回结果"],
    ["interrupted", "中断", false, ["继续", "重跑"], "user_abort"],
    ["cancelled", "已取消", false, ["重跑"], "user_cancel"],
  ] as const)("%s：%s 横条（红=%s），按钮 %j", async (status, title, red, buttons, stopReason) => {
    drawerBackend({ job: agentJob({ status, stopReason }) });
    await mount();
    const el = await screen.findByRole("status", { name: `任务${title}` });
    expect(el.className.includes("bg-danger/10")).toBe(red);
    expect(
      within(el)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(buttons);
    expect(within(el).queryByRole("button", { name: /取消任务/ })).toBeNull();
  });

  it.each(["done", "running", "queued", "awaiting_quota"] as const)("%s：不出横条", async (status: AgentJobStatus) => {
    const { calls } = drawerBackend({ job: agentJob({ status }) });
    await mount();
    await waitFor(() => expect(calls).toContain("snapshot"));
    expect(bar()).toBeNull();
  });

  it("没有任务：不出横条", async () => {
    const { calls } = drawerBackend({ job: null });
    renderWithProviders(
      <AgentFeedProvider templateId={TPL}>
        <BreakerBar />
      </AgentFeedProvider>,
    );
    act(() => findSource(`template:${TPL}`)?.open());
    await waitFor(() => expect(calls).toEqual(["snapshot"]));
    expect(bar()).toBeNull();
  });

  it("原因、用时、花费：熔断原因翻成人话；后端崩溃被标中断的用时显示「—」", async () => {
    drawerBackend({
      job: agentJob({ status: "interrupted", stopReason: "backend_restart", runElapsedMs: 0, costUsd: 0.31 }),
    });
    await mount();
    const el = await screen.findByRole("status", { name: "任务中断" });
    expect(el).toHaveTextContent("中断：后端重启，运行被打断");
    expect(el).toHaveTextContent("用时 — · 花费 $0.31（估）");
  });

  it("熔断：红条写「已熔断：超预算：…」与用时", async () => {
    drawerBackend({ job: agentJob({ status: "tripped", stopReason: "budget：花费达到上限", runElapsedMs: 125_000 }) });
    await mount();
    const el = await screen.findByRole("status", { name: "任务已熔断" });
    expect(el).toHaveTextContent("已熔断：超预算：花费达到上限");
    expect(el).toHaveTextContent("用时 2:05");
  });
});

describe("继续", () => {
  it("点「继续」调 continue；任务回到排队，横条消失，抽屉同一份数据跟着变（不各拉一份）", async () => {
    const user = userEvent.setup();
    const { db, calls } = drawerBackend({ job: agentJob({ status: "tripped", stopReason: "budget：花费达到上限" }) });
    await mount(true);
    const el = await screen.findByRole("status", { name: "任务已熔断" });
    const snapshotsBefore = calls.filter((c) => c === "snapshot").length;
    await user.click(within(el).getByRole("button", { name: "继续" }));
    expect(db.continueCalls).toBe(1);
    await waitFor(() => expect(bar()).toBeNull());
    // 抽屉顶栏同一时刻换成「排队」，而且没有为此另拉一次快照
    expect(within(screen.getByRole("complementary", { name: "Agent 过程" })).getByText("排队")).toBeInTheDocument();
    expect(calls.filter((c) => c === "snapshot").length).toBe(snapshotsBefore);
    // 整页只开了一条模板主题的 SSE（横条没另开一条）
    expect(findSource(`template:${TPL}`)?.topics).toEqual([`template:${TPL}`, "job:job-1"]);
  });

  it("继续失败：就地显示后端原文，按钮可以再点", async () => {
    const user = userEvent.setup();
    drawerBackend(
      { job: agentJob({ status: "interrupted", stopReason: "user_abort" }) },
      {
        "POST /api/agent-jobs/:id/continue": () => ({
          status: 409,
          body: { error: { message: "这个模板已经有一个没结束的任务" } },
        }),
      },
    );
    await mount();
    const el = await screen.findByRole("status", { name: "任务中断" });
    await user.click(within(el).getByRole("button", { name: "继续" }));
    expect(await within(el).findByText("继续失败：这个模板已经有一个没结束的任务")).toBeInTheDocument();
    expect(within(el).getByRole("button", { name: "继续" })).toBeEnabled();
  });
});

describe("重跑", () => {
  it("点「重跑」先二次确认，写明会删掉 Agent 产物；点取消不发请求", async () => {
    const user = userEvent.setup();
    const { db } = drawerBackend({ job: agentJob({ status: "cancelled", stopReason: "user_cancel" }) });
    await mount();
    const el = await screen.findByRole("status", { name: "任务已取消" });
    await user.click(within(el).getByRole("button", { name: "重跑" }));
    const dialog = screen.getByRole("dialog", { name: "重跑这个任务？" });
    expect(dialog).toHaveTextContent("会删掉 Agent 在工作目录顶层写出的文件");
    expect(dialog).toHaveTextContent("references、assets、productions 三个目录（证据、素材、变体数据）整个保留");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(db.rerunCalls).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("确认后调 rerun：换成新任务，横条消失，抽屉跟着换到新任务", async () => {
    const user = userEvent.setup();
    const { db } = drawerBackend({ job: agentJob({ status: "tripped", stopReason: "timeout：运行超过 45 分钟" }) });
    await mount(true);
    const el = await screen.findByRole("status", { name: "任务已熔断" });
    await user.click(within(el).getByRole("button", { name: "重跑" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "清掉产物并重跑" }));
    expect(db.rerunCalls).toBe(1);
    await waitFor(() => expect(bar()).toBeNull());
    await waitFor(() => expect(findSource("job:job-2")).toBeDefined());
    expect(within(screen.getByRole("complementary", { name: "Agent 过程" })).getByText("排队")).toBeInTheDocument();
  });

  it("重跑失败：关掉确认框，横条上显示原文，可以再点", async () => {
    const user = userEvent.setup();
    drawerBackend(
      { job: agentJob({ status: "failed", stopReason: "会话没有返回结果" }) },
      {
        "POST /api/agent-jobs/:id/rerun": () => ({
          status: 409,
          body: { error: { message: "只能对这个模板最新的任务操作" } },
        }),
      },
    );
    await mount();
    const el = await screen.findByRole("status", { name: "任务失败" });
    await user.click(within(el).getByRole("button", { name: "重跑" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "清掉产物并重跑" }));
    expect(await within(el).findByText("重跑失败：只能对这个模板最新的任务操作")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(el).getByRole("button", { name: "重跑" })).toBeEnabled();
  });
});

describe("请求状态只属于这一个任务的这一次停下（复审 S2-M1 / S2-L1）", () => {
  it("A 模板「继续」失败后切到 B 模板：B 的横条不带 A 的错误原文，按钮可点", async () => {
    const user = userEvent.setup();
    const jobs = {
      "tpl-1": agentJob({ id: "job-1", ownerId: "tpl-1", status: "tripped", stopReason: "budget：花费达到上限" }),
      "tpl-2": agentJob({
        id: "job-2",
        ownerId: "tpl-2",
        status: "tripped",
        stopReason: "idle：10 分钟没有任何新消息",
      }),
    };
    const empty = {
      messages: [],
      hasOlder: false,
      hasNewer: false,
      firstSeq: 0,
      lastSeq: 0,
      nextSeq: 0,
      jobLastSeq: 0,
    };
    stubFetch({
      "/api/templates/:id/agent-job": (_i, url) => ({
        body: { job: url?.includes("tpl-2") ? jobs["tpl-2"] : jobs["tpl-1"], ...empty },
      }),
      "/api/agent-jobs/:id": (_i, url) => ({
        body: { job: url?.includes("job-2") ? jobs["tpl-2"] : jobs["tpl-1"], jobLastSeq: 0 },
      }),
      "POST /api/agent-jobs/:id/continue": () => ({ status: 409, body: { error: { message: "A 模板的错误原文" } } }),
    });
    let switchTo: (id: string) => void = () => {};
    function Page() {
      const [tpl, setTpl] = useState("tpl-1");
      switchTo = setTpl;
      return (
        <AgentFeedProvider templateId={tpl}>
          <BreakerBar />
        </AgentFeedProvider>
      );
    }
    renderWithProviders(<Page />);
    act(() => findSource("template:tpl-1")?.open());
    const a = await screen.findByRole("status", { name: "任务已熔断" });
    await user.click(within(a).getByRole("button", { name: "继续" }));
    expect(await within(a).findByText("继续失败：A 模板的错误原文")).toBeInTheDocument();

    act(() => switchTo("tpl-2"));
    act(() => findSource("template:tpl-2")?.open());
    const b = await screen.findByRole("status", { name: "任务已熔断" });
    await waitFor(() => expect(b).toHaveTextContent("卡死：10 分钟没有任何新消息"));
    expect(screen.queryByText(/A 模板的错误原文/)).toBeNull();
    expect(within(b).getByRole("button", { name: "继续" })).toBeEnabled();
  });

  it("同一任务先失败、后来又跑起来再停下：旧的失败原文不再出现，开着的确认框不会自己弹出来", async () => {
    const user = userEvent.setup();
    drawerBackend(
      { job: agentJob({ status: "tripped", stopReason: "budget：花费达到上限" }) },
      { "POST /api/agent-jobs/:id/continue": () => ({ status: 504, body: { error: { message: "后端未响应" } } }) },
    );
    await mount();
    const bar1 = await screen.findByRole("status", { name: "任务已熔断" });
    await user.click(within(bar1).getByRole("button", { name: "继续" }));
    expect(await within(bar1).findByText("继续失败：后端未响应")).toBeInTheDocument();
    await user.click(within(bar1).getByRole("button", { name: "重跑" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // 其实后端已经排上了：别的页面 / 事件把任务推成运行中，再熔断
    const es = findSource("job:job-1");
    act(() => es?.emit("agent-job", `template:${TPL}`, agentJob({ status: "running", stopReason: null })));
    await waitFor(() => expect(bar()).toBeNull());
    act(() =>
      es?.emit(
        "agent-job",
        `template:${TPL}`,
        agentJob({ status: "tripped", stopReason: "timeout：运行超过 45 分钟" }),
      ),
    );
    const bar2 = await screen.findByRole("status", { name: "任务已熔断" });
    expect(bar2).toHaveTextContent("超时：运行超过 45 分钟");
    expect(within(bar2).queryByText(/继续失败/)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("复刻判据两次都没过（状态都是失败，只是结束时刻变了）：上一次「继续失败」的原文不留在新横条上", async () => {
    const user = userEvent.setup();
    drawerBackend(
      {
        job: agentJob({
          status: "failed",
          stopReason: "复刻未达完成判据：缺少 ANALYSIS.md",
          endedAt: "2026-09-23T10:00:00.000Z",
        }),
      },
      { "POST /api/agent-jobs/:id/continue": () => ({ status: 504, body: { error: { message: "后端未响应" } } }) },
    );
    await mount();
    const bar1 = await screen.findByRole("status", { name: "任务失败" });
    await user.click(within(bar1).getByRole("button", { name: "继续" }));
    expect(await within(bar1).findByText("继续失败：后端未响应")).toBeInTheDocument();

    // 中间「运行中」那条事件没赶上，直接收到下一次完成后又判不过的状态
    const next = agentJob({
      status: "failed",
      stopReason: "复刻未达完成判据：缺少 TIMELINE.md",
      endedAt: "2026-09-23T10:20:00.000Z",
    });
    act(() => findSource("job:job-1")?.emit("agent-job", `template:${TPL}`, next));
    const bar2 = await screen.findByRole("status", { name: "任务失败" });
    await waitFor(() => expect(bar2).toHaveTextContent("缺少 TIMELINE.md"));
    expect(within(bar2).queryByText(/继续失败/)).toBeNull();
  });
});
