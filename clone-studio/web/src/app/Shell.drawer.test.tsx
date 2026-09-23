import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../test/harness.js";
import { installEventSource } from "../test/fake-event-source.js";
import { agentJob, agentMessages as m } from "../test/agent-fixtures.js";
import { BASE, IDLE, stub, TPL_ID } from "../test/reference-fixtures.js";

/**
 * 抽屉挂在外壳上、在路由出口之外：模板页的 id 得由外壳自己匹配出来传进去。
 * 走真实路由表，桩只在 fetch 这一层。
 */
describe("外壳 · Agent 抽屉接进模板页", () => {
  it("在模板页：订阅该模板的主题，拿到任务后抽屉自己展开，显示顶栏与消息", async () => {
    const find = installEventSource();
    const job = agentJob({ ownerId: TPL_ID });
    stub("importing", IDLE, {
      [`/api/templates/${TPL_ID}/agent-job`]: {
        body: {
          job,
          messages: [m.init(1), m.assistant(2, [{ type: "text", text: "我先看参考视频。" }])],
          hasOlder: false,
          hasNewer: false,
          firstSeq: 1,
          lastSeq: 2,
          nextSeq: 2,
          jobLastSeq: 2,
        },
      },
      "/api/agent-jobs/:id": { body: { job, jobLastSeq: 2 } },
    });
    renderApp(`${BASE}/reference`);
    const es = await waitFor(() => {
      const s = find(`template:${TPL_ID}`);
      if (!s) throw new Error("没订阅模板主题");
      return s;
    });
    act(() => es.open());
    const drawer = await screen.findByRole("complementary", { name: "Agent 过程" });
    expect(await within(drawer).findByText("我先看参考视频。")).toBeInTheDocument();
    expect(within(drawer).getByText("运行中")).toBeInTheDocument();
  });

  it("任务熔断了：模板页步骤条下方、工作区上方出 CMP-009 横条，和抽屉看的是同一个任务", async () => {
    const find = installEventSource();
    const job = agentJob({ ownerId: TPL_ID, status: "tripped", stopReason: "budget：花费达到上限" });
    stub("importing", IDLE, {
      [`/api/templates/${TPL_ID}/agent-job`]: {
        body: {
          job,
          messages: [],
          hasOlder: false,
          hasNewer: false,
          firstSeq: 0,
          lastSeq: 0,
          nextSeq: 0,
          jobLastSeq: 0,
        },
      },
      "/api/agent-jobs/:id": { body: { job, jobLastSeq: 0 } },
    });
    renderApp(`${BASE}/reference`);
    const es = await waitFor(() => {
      const s = find(`template:${TPL_ID}`);
      if (!s) throw new Error("没订阅模板主题");
      return s;
    });
    act(() => es.open());
    const bar = await screen.findByRole("status", { name: "任务已熔断" });
    const stepper = screen.getByRole("navigation", { name: "流水线步骤" });
    // ① 参考 工作区的表单标题
    const workspace = await screen.findByText("导入参考视频");
    // 文档顺序：步骤条 → 横条 → 工作区
    expect(stepper.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 同一份数据：抽屉顶栏也是「已熔断」；整页只有一个任务取数（订阅任务主题的连接只有一条）。
    // ① 参考 页自己为证据流订阅了模板主题，那是另一件事，不算在内
    expect(
      within(screen.getByRole("complementary", { name: "Agent 过程" })).getAllByText("已熔断").length,
    ).toBeGreaterThan(0);
    const open = (
      globalThis.EventSource as unknown as { instances: { closed: boolean; url: string }[] }
    ).instances.filter((s) => !s.closed && s.url.includes(`job%3A${job.id}`));
    expect(open).toHaveLength(1);
  });

  it("不在模板页：不订阅任何模板主题，抽屉收着", async () => {
    const find = installEventSource();
    stub("importing", IDLE);
    renderApp("/settings");
    expect(await screen.findByRole("button", { name: "展开 Agent 过程抽屉" })).toBeInTheDocument();
    expect(find(`template:${TPL_ID}`)).toBeUndefined();
  });
});
