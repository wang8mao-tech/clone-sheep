import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { VariantReviewState } from "../../lib/variant-review.js";
import type { VariantView } from "../../lib/variants.js";
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

/** SCREEN-007 面板里的停因、闸门前后的卡片与批次条（8.4 第四轮审查 S1-M-1、S2-M-1） */

beforeEach(() => {
  installVariantSources();
});

const state = (v: VariantView, over: Partial<VariantReviewState> = {}): VariantReviewState => ({
  variant: v,
  assets: [],
  script: "台词",
  scriptTruncated: false,
  perItemLimitUsd: 1.5,
  batch: { id: "b1", limitUsd: 15, spentUsd: 2.4 },
  approveBlocked: null,
  reworkBlocked: null,
  ...over,
});

function stub(current: VariantReviewState, extra: Parameters<typeof variantsBackend>[1] = {}) {
  return variantsBackend([batch({ variants: [current.variant] })], {
    "/api/variants/:id/review": () => ({ body: current }),
    ...extra,
  });
}

const open = () => mountVariants("?variant=v2");
const panel = () => screen.findByRole("region", { name: "素材审核：手机排行" });

describe("停下原因（8.4 第四轮审查 S1-M-1）", () => {
  it("重试出片时估价被拦（估价比出片新）：写明估价没过与原因，出片卡仍在，不给重新估价", async () => {
    const build = buildView({ productionId: "v2", createdAt: "2026-09-24T08:00:00.000Z" });
    const est = estimateRecord({
      productionId: "v2",
      kind: "blocked",
      decision: "blocked",
      totalUsd: null,
      reason: "有请求没有价目",
      createdAt: "2026-09-24T09:00:00.000Z",
    });
    stub(state(variant(2, { status: "failed", name: "手机排行", approved: true, estimate: est, build })), {
      "/api/productions/:id/estimate": { body: { estimate: est } },
      "/api/productions/:id/build": { body: { build } },
    });
    await open();
    const why = await screen.findByLabelText("停下原因");
    expect(why).toHaveTextContent("估价没过，不出片");
    expect(why).toHaveTextContent("有请求没有价目");
    expect(await screen.findByRole("region", { name: "出片" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新估价" })).toBeNull();
  });

  it("出片失败、估价比出片旧：出片卡自己说错误，面板不重复写停因", async () => {
    const build = buildView({ productionId: "v2", createdAt: "2026-09-24T09:00:00.000Z" });
    const est = estimateRecord({ productionId: "v2", createdAt: "2026-09-24T08:00:00.000Z" });
    stub(state(variant(2, { status: "failed", name: "手机排行", approved: true, estimate: est, build })), {
      "/api/productions/:id/estimate": { body: { estimate: est } },
      "/api/productions/:id/build": { body: { build } },
    });
    await open();
    expect(await screen.findByRole("region", { name: "出片" })).toBeInTheDocument();
    expect(screen.queryByLabelText("停下原因")).toBeNull();
  });

  it("首次估价没过、还没出过片：估价卡写原因并给重新估价，面板不重复写停因（8.4 第五轮审查）", async () => {
    const est = estimateRecord({
      productionId: "v2",
      kind: "blocked",
      decision: "blocked",
      totalUsd: null,
      reason: "有请求没有价目",
    });
    stub(state(variant(2, { status: "failed", name: "手机排行", approved: true, estimate: est })), {
      "/api/productions/:id/estimate": { body: { estimate: est } },
    });
    await open();
    const card = await screen.findByRole("region", { name: "出片估价" });
    expect(await within(card).findByText("有请求没有价目")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "重新估价" })).toBeInTheDocument();
    expect(screen.queryByLabelText("停下原因")).toBeNull();
    expect(screen.getAllByText("有请求没有价目")).toHaveLength(1);
  });

  it("Agent 写稿熔断：写明 Agent 写稿停下与原因", async () => {
    const agent = agentJob({ ownerKind: "production", ownerId: "v2", status: "tripped", stopReason: "超出预算" });
    stub(state(variant(2, { status: "tripped", name: "手机排行", agent })));
    await open();
    expect(await screen.findByLabelText("停下原因")).toHaveTextContent("Agent 写稿停下：超出预算");
  });
});

describe("闸门前后的卡片（8.4 第四轮审查 S2-M-1）", () => {
  it("Agent 那一段失败、还没交给出片：没有估价卡", async () => {
    stub(state(variant(2, { status: "failed", name: "手机排行" })));
    await open();
    await panel();
    expect(screen.queryByRole("region", { name: "出片估价" })).toBeNull();
  });

  it("待确认花费：估价卡带批次条，批次已花不含这条自己", async () => {
    const est = estimateRecord({ productionId: "v2", totalUsd: 3.2, decision: "confirm" });
    stub(state(variant(2, { status: "awaiting_cost_confirm", name: "手机排行", approved: true, estimate: est })), {
      "/api/productions/:id/estimate": { body: { estimate: est } },
    });
    await open();
    expect(await screen.findByText("批次已花 $2.40 / $15.00")).toBeInTheDocument();
  });

  it("出片中途后端重启（中断）：显示出片卡", async () => {
    const build = buildView({ productionId: "v2", status: "cancelled" });
    stub(state(variant(2, { status: "interrupted", name: "手机排行", approved: true, build })), {
      "/api/productions/:id/build": { body: { build } },
    });
    await open();
    expect(await screen.findByRole("region", { name: "出片" })).toBeInTheDocument();
  });

  it("打回提交中：素材通过不可点，写明在提交打回", async () => {
    stub(state(variant(2, { status: "asset_review", needsMe: true, name: "手机排行" })));
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/rework")) return new Promise<Response>(() => undefined);
      return inner(input, init);
    });
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: "打回" }));
    await user.type(screen.getByLabelText("打回意见"), "换图");
    await user.click(screen.getByRole("button", { name: "提交打回" }));
    const approve = screen.getByRole("button", { name: "素材通过" });
    await waitFor(() => expect(approve).toBeDisabled());
    expect(approve).toHaveAttribute("title", "正在提交打回");
  });
});
