import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/harness.js";
import { installEventSource } from "../test/fake-event-source.js";
import { agentJob } from "../test/agent-fixtures.js";
import { BASE, IDLE, stub, TPL_ID } from "../test/reference-fixtures.js";
import { batch, variant } from "../test/variants-kit.js";

/**
 * 抽屉跟随所选对象（Design-Brief §2.3「在 007 显示该变体的任务」，Task 9.3）：
 * ④ 打开某条变体的素材审核（?variant=）时，外壳的数据源换成那条变体的任务，CMP-009 横条也跟着它
 */

const snapshot = (job: ReturnType<typeof agentJob>) => ({
  body: { job, messages: [], hasOlder: false, hasNewer: false, firstSeq: 0, lastSeq: 0, nextSeq: 0, jobLastSeq: 0 },
});

function setup(
  owner: { templateId: string; continue: boolean; rerun: boolean } = {
    templateId: TPL_ID,
    continue: true,
    rerun: true,
  },
) {
  const find = installEventSource();
  const templateJob = agentJob({ id: "tpl-job", ownerId: TPL_ID, status: "done", stopReason: null });
  const variantJob = agentJob({
    id: "var-job",
    ownerKind: "production",
    ownerId: "v2",
    status: "tripped",
    stopReason: "budget：花费达到上限",
  });
  const v2 = variant(2, { status: "tripped", name: "手机排行", agent: variantJob });
  stub(
    "approved",
    IDLE,
    {
      [`/api/templates/${TPL_ID}/agent-job`]: snapshot(templateJob),
      "/api/productions/:id/agent-job": { body: { ...snapshot(variantJob).body, owner } },
      "/api/agent-jobs/:id": (_i, url) => ({
        body: url?.includes("var-job")
          ? { job: variantJob, jobLastSeq: 0, owner }
          : { job: templateJob, jobLastSeq: 0 },
      }),
      [`/api/templates/${TPL_ID}/variants`]: { body: { batches: [batch({ variants: [v2] })] } },
      "/api/agent-models": { body: { models: [{ id: null, label: "订阅默认模型", disabledReason: null }] } },
      "/api/settings": {
        body: {
          referenceMaxSeconds: 180,
          perItemLimitUsd: 1.5,
          batchLimitUsd: 15,
          batchMaxItems: 20,
          agentBudgetUsd: 5,
        },
      },
      "/api/variants/:id/review": {
        body: {
          templateId: TPL_ID,
          variant: v2,
          assets: [],
          script: null,
          scriptTruncated: false,
          perItemLimitUsd: 1.5,
          batch: null,
          approveBlocked: "只有素材待审的变体能通过",
          reworkBlocked: "只有素材待审的变体能打回",
        },
      },
      "/api/productions/:id/costs": {
        body: { productionId: "v2", agent: [], builds: [], totalUsd: 0, totalIsEstimate: false },
      },
    },
    { approvedReplicaId: "r1" },
  );
  return find;
}

describe("外壳 · 抽屉跟随所选变体（Task 9.3）", () => {
  it("④ 打开 ?variant=v2：订阅这条变体的主题，抽屉和 CMP-009 横条都是它的任务，重跑写明是变体的重跑", async () => {
    const find = setup();
    renderApp(`${BASE}/variants?variant=v2`);
    const es = await waitFor(() => {
      const s = find(`production:v2`);
      if (!s) throw new Error("没订阅变体主题");
      return s;
    });
    act(() => es.open());

    const bar = await screen.findByRole("status", { name: "任务已熔断" });
    expect(bar).toHaveTextContent("超预算：花费达到上限");
    const drawer = screen.getByRole("complementary", { name: "Agent 过程" });
    expect(drawer).toHaveTextContent("已熔断");

    const user = userEvent.setup();
    await user.click(within(bar).getByRole("button", { name: "重跑" }));
    const confirm = await screen.findByRole("dialog", { name: "重跑这个任务？" });
    expect(confirm).toHaveTextContent("清掉这条变体 Agent 写的稿子、清单与抓来的图（你替换过的图留着），素材要重新审");
    expect(confirm).not.toHaveTextContent("ANALYSIS.md");
  });

  it("选了没有任务的变体：抽屉写这条变体还没有任务（不是说模板）", async () => {
    const find = setup();
    stub(
      "approved",
      IDLE,
      {
        [`/api/templates/${TPL_ID}/agent-job`]: snapshot(agentJob({ id: "tpl-job", ownerId: TPL_ID, status: "done" })),
        "/api/productions/:id/agent-job": {
          body: {
            job: null,
            messages: [],
            hasOlder: false,
            hasNewer: false,
            firstSeq: 0,
            lastSeq: 0,
            nextSeq: 0,
            jobLastSeq: 0,
          },
        },
        [`/api/templates/${TPL_ID}/variants`]: {
          body: { batches: [batch({ variants: [variant(2, { name: "手机排行" })] })] },
        },
        "/api/agent-models": { body: { models: [{ id: null, label: "订阅默认模型", disabledReason: null }] } },
        "/api/settings": {
          body: {
            referenceMaxSeconds: 180,
            perItemLimitUsd: 1.5,
            batchLimitUsd: 15,
            batchMaxItems: 20,
            agentBudgetUsd: 5,
          },
        },
        "/api/variants/:id/review": {
          body: {
            templateId: TPL_ID,
            variant: variant(2, { name: "手机排行" }),
            assets: [],
            script: null,
            scriptTruncated: false,
            perItemLimitUsd: 1.5,
            batch: null,
            approveBlocked: "x",
            reworkBlocked: "x",
          },
        },
        "/api/productions/:id/costs": {
          body: { productionId: "v2", agent: [], builds: [], totalUsd: 0, totalIsEstimate: false },
        },
      },
      { approvedReplicaId: "r1" },
    );
    renderApp(`${BASE}/variants?variant=v2`);
    const es = await waitFor(() => {
      const s = find(`production:v2`);
      if (!s) throw new Error("没订阅变体主题");
      return s;
    });
    act(() => es.open());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "展开 Agent 过程抽屉" }));
    expect(await screen.findByText("这条变体还没有 Agent 任务。")).toBeInTheDocument();
  });

  it("别的步骤带着 ?variant=（比如 ⑤）：不跟变体，照旧跟模板", async () => {
    const find = setup();
    renderApp(`${BASE}/outputs?variant=v2`);
    await waitFor(() => {
      if (!find(`template:${TPL_ID}`)) throw new Error("没订阅模板主题");
    });
    expect(find(`production:v2`)).toBeUndefined();
  });

  it("?variant= 是别的模板的变体：抽屉与 CMP-009 都不跟它（9.3 审查 S1-M1）", async () => {
    const find = setup({ templateId: "another-template", continue: true, rerun: true });
    renderApp(`${BASE}/variants?variant=v2`);
    const es = await waitFor(() => {
      const s = find(`production:v2`);
      if (!s) throw new Error("没订阅变体主题");
      return s;
    });
    act(() => es.open());
    await screen.findByRole("region", { name: "④ 变体 工作区" });
    await waitFor(() => expect(screen.queryByRole("status", { name: "任务已熔断" })).toBeNull());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "展开 Agent 过程抽屉" }));
    expect(await screen.findByText("这个模板下没有这条变体。")).toBeInTheDocument();
  });

  it("变体已作废（服务端说不能继续也不能重跑）：没有 CMP-009 横条，抽屉结束卡不提继续 / 重跑（9.3 审查 S1-M2）", async () => {
    const find = setup({ templateId: TPL_ID, continue: false, rerun: false });
    renderApp(`${BASE}/variants?variant=v2`);
    const es = await waitFor(() => {
      const s = find(`production:v2`);
      if (!s) throw new Error("没订阅变体主题");
      return s;
    });
    act(() => es.open());
    const drawer = await screen.findByRole("complementary", { name: "Agent 过程" });
    await within(drawer).findByRole("status", { name: "结束：已熔断" });
    expect(screen.queryByRole("status", { name: "任务已熔断" })).toBeNull();
    expect(drawer).not.toHaveTextContent("可以继续");
    expect(drawer).not.toHaveTextContent("重跑");
  });

  it("在 007 取消这条变体（任务本身没变）：CMP-009 横条随之收起（9.3 第二轮审查 S1-M1）", async () => {
    const owner = { templateId: TPL_ID, continue: true, rerun: true };
    const find = setup(owner);
    renderApp(`${BASE}/variants?variant=v2`);
    const es = await waitFor(() => {
      const s = find(`production:v2`);
      if (!s) throw new Error("没订阅变体主题");
      return s;
    });
    act(() => es.open());
    await screen.findByRole("status", { name: "任务已熔断" });
    owner.continue = false;
    owner.rerun = false;
    act(() => es.emit("variants", `template:${TPL_ID}`, {}));
    await waitFor(() => expect(screen.queryByRole("status", { name: "任务已熔断" })).toBeNull());
  });

  it("在 ④ 队列（没选变体）：跟模板的任务，不订阅变体主题", async () => {
    const find = setup();
    renderApp(`${BASE}/variants`);
    const es = await waitFor(() => {
      const s = find(`template:${TPL_ID}`);
      if (!s) throw new Error("没订阅模板主题");
      return s;
    });
    act(() => es.open());
    await screen.findByRole("region", { name: "④ 变体 工作区" });
    expect(find(`production:v2`)).toBeUndefined();
    expect(screen.queryByRole("status", { name: "任务已熔断" })).toBeNull();
  });
});
