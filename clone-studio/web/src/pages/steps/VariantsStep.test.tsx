import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { agentJob } from "../../test/agent-fixtures.js";
import { TPL } from "../../test/agent-drawer-kit.js";
import { ControlledEventSource } from "../../test/fake-event-source.js";
import {
  batch,
  buildView,
  estimateRecord,
  installVariantSources,
  mountVariants,
  variant,
  variantsBackend,
} from "../../test/variants-kit.js";

/** SCREEN-006 ④ 变体：提交区（校验、示例、提交）、按批次分组的队列（置顶、筛选、组头）、行尾动作（AC-014 / AC-016 前端） */

beforeEach(() => {
  installVariantSources();
});

const briefBox = () => screen.getByLabelText("Brief（一行一条）");
const submitButton = () => screen.getByRole("button", { name: /^提交 \d+ 条变体$/ });

describe("提交区", () => {
  it("空队列：提交区展开，列三条示例，点一条填进去，实时显示条数", async () => {
    variantsBackend([]);
    const { user } = await mountVariants();
    expect(await screen.findByText("还没有变体。在上面写几条 brief 提交，变体会按批次排在这里。")).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute("title", "先写 brief");
    await user.click(screen.getByRole("button", { name: "换成 2026 年手机品牌排行，毒舌风格，普通话" }));
    expect(briefBox()).toHaveValue("换成 2026 年手机品牌排行，毒舌风格，普通话");
    expect(screen.getByText("1 条")).toBeInTheDocument();
    expect(submitButton()).toHaveTextContent("提交 1 条变体");
  });

  it("21 行：红字「一次最多 20 条」，提交不可点，不发请求（AC-016）", async () => {
    const db = variantsBackend([]);
    await mountVariants();
    const lines = Array.from({ length: 21 }, (_, i) => `换成第 ${i + 1} 个品牌的排行榜`).join("\n");
    fireEvent.change(briefBox(), { target: { value: lines } });
    expect(screen.getByRole("alert")).toHaveTextContent("一次最多 20 条，现在是 21 条");
    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute("title", "一次最多 20 条，现在是 21 条");
    fireEvent.click(submitButton());
    expect(db.submits).toEqual([]);
  });

  it("单行太短 / 太长：逐行红字，空行不算条数", async () => {
    variantsBackend([]);
    await mountVariants();
    fireEvent.change(briefBox(), { target: { value: `换成手机品牌排行\n\n短\n${"字".repeat(501)}` } });
    expect(screen.getByText("3 条")).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("第 3 行不到 5 字");
    expect(alert).toHaveTextContent("第 4 行超过 500 字（501），删短一些");
    expect(submitButton()).toBeDisabled();
    // 边界：刚好 4 字不行，刚好 5 字可以
    fireEvent.change(briefBox(), { target: { value: "四个字的\n五个字的呀" } });
    expect(screen.getByRole("alert")).toHaveTextContent("第 1 行不到 5 字");
    expect(screen.getByRole("alert")).not.toHaveTextContent("第 2 行");
  });

  it("设置里的条数上限调到 50：前端照样封顶 20，21 行不让提交（与服务端一致）", async () => {
    variantsBackend([], {
      "/api/settings": { body: { perItemLimitUsd: 1.5, batchLimitUsd: 15, batchMaxItems: 50, agentBudgetUsd: 5 } },
    });
    await mountVariants();
    await waitFor(() => expect(screen.getByText(/最多 20 条/)).toBeInTheDocument());
    const lines = Array.from({ length: 21 }, (_, i) => `换成第 ${i + 1} 个品牌的排行榜`).join("\n");
    fireEvent.change(briefBox(), { target: { value: lines } });
    expect(submitButton()).toBeDisabled();
    expect(briefBox()).toHaveAttribute("aria-describedby", expect.stringContaining("-errors"));
  });

  it("还没填 key 的档案置灰并写原因；默认选默认档案；批次限额低于单条限额不让提交", async () => {
    variantsBackend([]);
    await mountVariants();
    const model = await screen.findByLabelText("Agent 模型");
    await waitFor(() => expect(within(model).getByRole("option", { name: /没 key 的端点/ })).toBeDisabled());
    // 原因写在选项文字里，看得见也读得到（CMP-010）
    expect(within(model).getByRole("option", { name: /没 key 的端点（不可选：还没有 API key）/ })).toBeInTheDocument();
    expect(model).toHaveValue("subscription");
    fireEvent.change(briefBox(), { target: { value: "换成手机品牌排行榜" } });
    fireEvent.change(screen.getByLabelText("批次限额 USD"), { target: { value: "1" } });
    expect(submitButton()).toBeDisabled();
    expect(screen.getByText("要在单条限额 $1.5 到 $1000 之间")).toBeInTheDocument();
  });

  it("提交：带上 brief、语言、备注、模型、限额；成功后清空表单、队列里出现新批次", async () => {
    const db = variantsBackend([]);
    const { user } = await mountVariants();
    fireEvent.change(briefBox(), { target: { value: "换成手机品牌排行榜\n换成汽车品牌排行榜" } });
    await user.selectOptions(screen.getByLabelText("目标语言"), "en");
    await user.selectOptions(await screen.findByLabelText("Agent 模型"), "p-sonnet");
    fireEvent.change(screen.getByLabelText("批次备注（附加给每一条）"), { target: { value: " 片尾加关注 " } });
    await user.click(submitButton());
    await waitFor(() => expect(db.submits).toHaveLength(1));
    expect(db.submits[0]).toEqual({
      briefs: "换成手机品牌排行榜\n换成汽车品牌排行榜",
      targetLanguage: "en",
      note: "片尾加关注",
      profileId: "p-sonnet",
      budgetUsd: 15,
    });
    expect(await screen.findByRole("list", { name: "批次 毒舌风格 的变体" })).toBeInTheDocument();
    // 提交成功后表单清空，不会一不小心把同一批再提交一遍
    // 队列里有了批次，提交区收起；再展开是空的
    const toggle = await screen.findByRole("button", { name: "提交批量变体" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(briefBox()).toHaveValue("");
  });

  it("服务端拒绝：写明没有提交与原因", async () => {
    variantsBackend([], {
      [`POST /api/templates/${TPL}/batches`]: {
        status: 409,
        body: { error: { code: "NOT_APPROVED", message: "先通过验货，才能批量出变体" } },
      },
    });
    const { user } = await mountVariants();
    fireEvent.change(briefBox(), { target: { value: "换成手机品牌排行榜" } });
    await user.click(submitButton());
    expect(await screen.findByText("没有提交：先通过验货，才能批量出变体")).toBeInTheDocument();
  });
});

describe("队列", () => {
  const needs = variant(2, { status: "asset_review", needsMe: true, name: "待审的" });
  const confirm = variant(3, { status: "awaiting_cost_confirm", needsMe: true, name: "待确认的" });

  it("要人动手的置顶并带竖线；组头有批次花费条；限额用尽时琥珀提示", async () => {
    variantsBackend([batch({ variants: [variant(1), needs, confirm], spentUsd: 14.5, halted: true })]);
    await mountVariants();
    const list = await screen.findByRole("list", { name: "批次 毒舌风格 的变体" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("待审的"),
      expect.stringContaining("待确认的"),
      expect.stringContaining("换成第 1 个品牌的排行"),
    ]);
    expect(rows[0]).toHaveClass("border-l-primary");
    expect(rows[1]).toHaveClass("border-l-warning");
    expect(screen.getByRole("meter", { name: "批次已花 $14.50，限额 $15.00" })).toBeInTheDocument();
    expect(screen.getByText("批次限额已用尽，剩余变体等你确认")).toBeInTheDocument();
  });

  it("五个筛选带数量；「需要我处理」只剩待审与待确认；「失败」含熔断与中断；筛不出东西时说一句", async () => {
    variantsBackend([
      batch({
        variants: [
          variant(1),
          needs,
          confirm,
          variant(7, { status: "tripped", name: "熔断的" }),
          variant(8, { status: "interrupted", name: "中断的" }),
        ],
      }),
    ]);
    const { user } = await mountVariants();
    await screen.findByRole("list", { name: "批次 毒舌风格 的变体" });
    expect(screen.getByRole("button", { name: "失败 2" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "需要我处理 2" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "完成 0" }));
    expect(screen.getByText("这个筛选下没有变体。")).toBeInTheDocument();
  });

  it("出片失败的行：就地展开 code 与原文；重试出片直接发，重跑先确认", async () => {
    const failed = variant(4, {
      status: "failed",
      name: "出片失败的",
      build: buildView(),
      estimate: estimateRecord(),
    });
    const db = variantsBackend([batch({ variants: [failed] })]);
    const { user } = await mountVariants();
    await user.click(await screen.findByRole("button", { name: "展开错误原文" }));
    expect(screen.getByText(/出片失败 · BUILD_FAILED\s+渲染炸了/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "重试出片" }));
    await waitFor(() => expect(db.retries).toEqual(["v4"]));
    await user.click(screen.getByRole("button", { name: "重跑" }));
    expect(db.reruns).toEqual([]);
    const dialog = await screen.findByRole("dialog", { name: "重跑变体「出片失败的」" });
    await user.click(within(dialog).getByRole("button", { name: "重跑" }));
    await waitFor(() => expect(db.reruns).toEqual(["v4"]));
  });

  it("素材待审的行：给重跑与取消，不给继续与重试出片", async () => {
    variantsBackend([batch({ variants: [needs] })]);
    await mountVariants();
    const row = await screen.findByRole("listitem");
    expect(within(row).getByRole("button", { name: "重跑" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "继续" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "重试出片" })).toBeNull();
  });

  it("取消先确认，确认后发请求；失败时写明哪一条什么动作没成功", async () => {
    const running = variant(5, { status: "agent_running", name: "写稿中的", agent: agentJob({ status: "running" }) });
    const db = variantsBackend([batch({ variants: [running] })], {
      "POST /api/variants/:id/cancel": {
        status: 409,
        body: { error: { code: "NOT_CANCELLABLE", message: "这条已经结束了" } },
      },
    });
    const { user } = await mountVariants();
    await user.click(await screen.findByRole("button", { name: "取消" }));
    const dialog = await screen.findByRole("dialog", { name: "取消变体「写稿中的」" });
    await user.click(within(dialog).getByRole("button", { name: "取消这条变体" }));
    expect(await screen.findByText("「写稿中的」取消没成功：这条已经结束了")).toBeInTheDocument();
    expect(db.cancels).toEqual([]);
  });

  it("Agent 停下的（熔断）：给继续，调任务的继续接口；停止原因可展开", async () => {
    const tripped = variant(6, {
      status: "tripped",
      name: "熔断的",
      agent: agentJob({ id: "job-6", status: "tripped", sessionId: "s6", stopReason: "budget" }),
    });
    const db = variantsBackend([batch({ variants: [tripped] })]);
    const { user } = await mountVariants();
    await user.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(db.drawer?.continueCalls).toBe(1));
    await user.click(screen.getByRole("button", { name: "展开错误原文" }));
    expect(screen.getByText("Agent 写稿停下：超预算")).toBeInTheDocument();
  });

  it("后端推 variants / estimate / build 事件：队列重拉", async () => {
    const db = variantsBackend([batch()]);
    await mountVariants();
    await screen.findByRole("list", { name: "批次 毒舌风格 的变体" });
    const before = db.reads;
    act(() => {
      for (const es of ControlledEventSource.instances) {
        if (!es.closed && es.topics.includes(`template:${TPL}`)) es.emit("variants", `template:${TPL}`, {});
      }
    });
    await waitFor(() => expect(db.reads).toBeGreaterThan(before));
    // 估价（待确认花费 → 排队）与出片的变化同样要重拉：待确认花费不在轮询的状态里
    for (const name of ["estimate", "build"]) {
      const at = db.reads;
      act(() => {
        for (const es of ControlledEventSource.instances) {
          if (!es.closed && es.topics.includes(`template:${TPL}`)) es.emit(name, `template:${TPL}`, {});
        }
      });
      await waitFor(() => expect(db.reads).toBeGreaterThan(at));
    }
  });

  it("读不到队列：错误态", async () => {
    variantsBackend([], {
      [`/api/templates/${TPL}/variants`]: { status: 500, body: { error: { code: "X", message: "炸了" } } },
    });
    await mountVariants();
    expect(await screen.findByText("读不到变体队列")).toBeInTheDocument();
  });
});
