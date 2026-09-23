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

  it("不在模板页：不订阅任何模板主题，抽屉收着", async () => {
    const find = installEventSource();
    stub("importing", IDLE);
    renderApp("/settings");
    expect(await screen.findByRole("button", { name: "展开 Agent 过程抽屉" })).toBeInTheDocument();
    expect(find(`template:${TPL_ID}`)).toBeUndefined();
  });
});
