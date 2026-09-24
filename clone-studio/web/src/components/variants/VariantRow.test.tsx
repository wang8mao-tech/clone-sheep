import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { agentJob } from "../../test/agent-fixtures.js";
import {
  batch,
  buildView,
  estimateRecord,
  installVariantSources,
  mountVariants,
  variant,
  variantsBackend,
} from "../../test/variants-kit.js";

/**
 * ④ 变体队列的行尾动作与服务端真实规则对齐（8.3 审查 HIGH-1）：交给出片之后停下的不给「继续」，
 * 渲染被打断的给「重试出片」；已取消的任务没有会话可继续，只能重跑。错误原文先说哪一步失败
 */

beforeEach(() => {
  installVariantSources();
});

describe("行尾动作", () => {
  it("渲染到一半后端重启（中断 + 出片失败）：给重试出片，不给注定被拒的继续（8.3 审查 HIGH-1）", async () => {
    const v = variant(9, {
      status: "interrupted",
      name: "重启打断的",
      agent: agentJob({ id: "job-9", status: "done", sessionId: "s9" }),
      estimate: estimateRecord(),
      build: buildView({ errorCode: "BACKEND_RESTART", errorMessage: "后端重启，出片被打断" }),
    });
    const db = variantsBackend([batch({ variants: [v] })]);
    const { user } = await mountVariants();
    const row = await screen.findByRole("listitem");
    expect(within(row).queryByRole("button", { name: "继续" })).toBeNull();
    await user.click(within(row).getByRole("button", { name: "展开错误原文" }));
    expect(screen.getByText(/出片失败 · BACKEND_RESTART\s+后端重启，出片被打断/)).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "重试出片" }));
    await waitFor(() => expect(db.retries).toEqual(["v9"]));
  });

  it("估价没过（失败、没有出片记录）：写明估价没过与原因，不给继续与重试出片，给重跑", async () => {
    const v = variant(10, {
      status: "failed",
      name: "估价没过的",
      agent: agentJob({ id: "job-10", status: "done", sessionId: "s10" }),
      estimate: estimateRecord({ kind: "blocked", decision: "blocked", reason: "有 1 个请求没有 Provider 可解析" }),
    });
    variantsBackend([batch({ variants: [v] })]);
    const { user } = await mountVariants();
    const row = await screen.findByRole("listitem");
    expect(within(row).queryByRole("button", { name: "继续" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "重试出片" })).toBeNull();
    expect(within(row).getByRole("button", { name: "重跑" })).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "展开错误原文" }));
    expect(screen.getByText(/估价没过，不出片\s+有 1 个请求没有 Provider 可解析/)).toBeInTheDocument();
  });

  it("已交给估价之后停下：哪怕任务本身显示可继续，也不给继续（服务端会以已交给出片拒绝）", async () => {
    const v = variant(12, {
      status: "failed",
      name: "交出去之后的",
      agent: agentJob({ id: "job-12", status: "failed", sessionId: "s12" }),
      estimate: estimateRecord({ kind: "blocked", decision: "blocked", reason: "没有 Provider" }),
    });
    variantsBackend([batch({ variants: [v] })]);
    await mountVariants();
    const row = await screen.findByRole("listitem");
    expect(within(row).queryByRole("button", { name: "继续" })).toBeNull();
  });

  it("重试出片后重新估价没过：先说估价没过与原因，不再只显示旧的出片错误（8.3 第二轮审查 S1-M1）", async () => {
    const v = variant(13, {
      status: "failed",
      name: "重试后估价没过的",
      agent: agentJob({ id: "job-13", status: "done", sessionId: "s13" }),
      build: buildView({ createdAt: "2026-09-24T08:00:00.000Z" }),
      estimate: estimateRecord({
        kind: "blocked",
        decision: "blocked",
        reason: "preflight 没过：缺配音能力",
        createdAt: "2026-09-24T09:00:00.000Z",
      }),
    });
    variantsBackend([batch({ variants: [v] })]);
    const { user } = await mountVariants();
    const row = await screen.findByRole("listitem");
    await user.click(within(row).getByRole("button", { name: "展开错误原文" }));
    expect(screen.getByText(/估价没过，不出片\s+preflight 没过：缺配音能力/)).toBeInTheDocument();
  });

  it("人取消的那次出片（build 已取消、变体回到失败）：可以重试出片", async () => {
    const v = variant(14, {
      status: "failed",
      name: "取消了出片的",
      agent: agentJob({ id: "job-14", status: "done", sessionId: "s14" }),
      estimate: estimateRecord(),
      build: buildView({ status: "cancelled", errorCode: "CANCELLED", errorMessage: "已取消出片" }),
    });
    variantsBackend([batch({ variants: [v] })]);
    await mountVariants();
    const row = await screen.findByRole("listitem");
    expect(within(row).getByRole("button", { name: "重试出片" })).toBeInTheDocument();
  });

  it("已取消的变体：行上的花费只算 Agent 的，放行过的估价不再占钱", async () => {
    const v = variant(15, {
      status: "cancelled",
      name: "取消了的",
      agent: agentJob({ id: "job-15", status: "done", costUsd: 0.2 }),
      estimate: estimateRecord({ totalUsd: 0.9, decision: "auto" }),
    });
    variantsBackend([batch({ variants: [v] })]);
    await mountVariants();
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("$0.20 估")).toBeInTheDocument();
  });

  it("没有标记的行也画一条透明竖线，和带标记的行、列头对齐", async () => {
    variantsBackend([batch({ variants: [variant(16, { name: "普通的" })] })]);
    await mountVariants();
    const row = await screen.findByRole("listitem");
    expect(row).toHaveClass("border-l-2", "border-l-transparent");
  });

  it("抽屉里中止了还没开跑的任务（任务已取消、变体中断）：没有会话可继续，只给重跑", async () => {
    const v = variant(11, {
      status: "interrupted",
      name: "中止的",
      agent: agentJob({ id: "job-11", status: "cancelled", sessionId: null, stopReason: "user_cancel" }),
    });
    variantsBackend([batch({ variants: [v] })]);
    await mountVariants();
    const row = await screen.findByRole("listitem");
    expect(within(row).queryByRole("button", { name: "继续" })).toBeNull();
    expect(within(row).getByRole("button", { name: "重跑" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "取消" })).toBeInTheDocument();
  });
});
