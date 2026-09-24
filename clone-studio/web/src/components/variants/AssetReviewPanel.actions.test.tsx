import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { AssetView, VariantReviewState } from "../../lib/variant-review.js";
import {
  batch,
  buildView,
  estimateRecord,
  installVariantSources,
  mountVariants,
  variant,
  variantsBackend,
} from "../../test/variants-kit.js";

/** SCREEN-007 素材审核面板的动作与状态（8.4 审查）：取消、替换中锁住提交、估价卡与出片卡、失败文案、从队列点开 */

beforeEach(() => {
  installVariantSources();
});

const asset = (n: number, over: Partial<AssetView> = {}): AssetView => ({
  id: `a${n}`,
  label: `条目 ${n}`,
  file: `assets/0${n}.jpg`,
  sourceUrl: `https://img${n}.example.com/x`,
  sourceHost: `img${n}.example.com`,
  replaced: false,
  gap: false,
  imageUrl: `/api/assets/a${n}/file?v=1`,
  ...over,
});

const state = (over: Partial<VariantReviewState> = {}): VariantReviewState => ({
  variant: variant(2, { status: "asset_review", needsMe: true, name: "手机排行" }),
  assets: [asset(1)],
  script: "台词",
  scriptTruncated: false,
  perItemLimitUsd: 1.5,
  batch: { id: "b1", limitUsd: 15, spentUsd: 0 },
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

describe("动作", () => {
  it("取消该变体：先确认，确认后调取消接口（SCREEN-007 次要操作）", async () => {
    const db = stub(state());
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: "取消该变体" }));
    const dialog = await screen.findByRole("dialog", { name: "取消变体「手机排行」" });
    expect(db.cancels).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "取消这条变体" }));
    await waitFor(() => expect(db.cancels).toEqual(["v2"]));
  });

  it("替换还在转换：素材通过与打回都不可点，写明在换图（8.4 审查 S1-M3）", async () => {
    stub(state());
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/replace")) return new Promise<Response>(() => undefined);
      return inner(input, init);
    });
    const { user } = await open();
    await user.upload(await screen.findByLabelText("替换 条目 1"), new File(["x"], "a.png", { type: "image/png" }));
    const approve = screen.getByRole("button", { name: "素材通过" });
    await waitFor(() => expect(approve).toBeDisabled());
    expect(approve).toHaveAttribute("title", "正在替换图片，换完再提交");
    expect(screen.getByRole("button", { name: "打回" })).toBeDisabled();
  });

  it("打回被拒：写明打回没提交与原因", async () => {
    stub(state(), {
      "POST /api/variants/:id/rework": {
        status: 409,
        body: { error: { code: "NOT_REVIEWING", message: "这条变体不在素材待审" } },
      },
    });
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: "打回" }));
    await user.type(screen.getByLabelText("打回意见"), "换图");
    await user.click(screen.getByRole("button", { name: "提交打回" }));
    expect(await screen.findByText("打回没提交：这条变体不在素材待审")).toBeInTheDocument();
  });

  it("替换时连不上后端：卡片上写明", async () => {
    stub(state());
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/replace")) return Promise.reject(new TypeError("Failed to fetch"));
      return inner(input, init);
    });
    const { user } = await open();
    await user.upload(await screen.findByLabelText("替换 条目 1"), new File(["x"], "a.png", { type: "image/png" }));
    expect(await screen.findByText("没换成：替换失败：连不上后端，确认后端在运行后重试。")).toBeInTheDocument();
  });
});

describe("估价卡与出片卡", () => {
  it("超限停在待确认花费：估价卡给「确认出片 $x」，不再给素材通过（AC-018 前端）", async () => {
    const est = estimateRecord({
      productionId: "v2",
      totalUsd: 2.1,
      decision: "confirm",
      reasons: ["over_item_limit"],
    });
    stub(
      state({
        variant: variant(2, { status: "awaiting_cost_confirm", name: "手机排行", estimate: est }),
        approveBlocked: "只有素材待审的变体能通过",
      }),
      { "/api/productions/:id/estimate": { body: { estimate: est } } },
    );
    await open();
    expect(await screen.findByRole("button", { name: "确认出片 $2.10" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "素材通过" })).toBeNull();
  });

  it("渲染中：出片卡（CMP-007）出现", async () => {
    const build = buildView({ productionId: "v2", status: "running", errorCode: null, errorMessage: null });
    stub(
      state({
        variant: variant(2, { status: "building", name: "手机排行", estimate: estimateRecord(), build }),
      }),
      {
        "/api/productions/:id/estimate": { body: { estimate: estimateRecord() } },
        "/api/productions/:id/build": { body: { build } },
      },
    );
    await open();
    expect(await screen.findByRole("button", { name: "取消" })).toBeInTheDocument();
  });
});

describe("过了闸门不再挂估价卡（8.4 第二轮审查 S1-M-A）", () => {
  it.each([
    ["cancelled", estimateRecord({ productionId: "v2", totalUsd: 2.1, decision: "confirm" })],
    ["done", estimateRecord({ productionId: "v2", decision: "auto" })],
  ] as const)("%s：没有「确认出片」「重新估价」", async (status, est) => {
    stub(
      state({
        variant: variant(2, { status, name: "手机排行", estimate: est }),
        approveBlocked: "只有素材待审的变体能通过",
      }),
      { "/api/productions/:id/estimate": { body: { estimate: est } } },
    );
    await open();
    await screen.findByRole("region", { name: "素材审核：手机排行" });
    expect(screen.queryByRole("button", { name: /确认出片/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新估价" })).toBeNull();
    expect(screen.queryByText("限额内，将自动出片")).toBeNull();
  });
});

describe("闸门前后的卡片（8.4 第三轮审查）", () => {
  it("素材通过后排队、估价还没回来：估价卡显示正在估价，并给重新估价当出口", async () => {
    stub(
      state({
        variant: variant(2, { status: "queued", name: "手机排行", approved: true }),
        approveBlocked: "只有素材待审的变体能通过",
      }),
      {
        "/api/productions/:id/estimate": {
          status: 404,
          body: { error: { code: "NO_ESTIMATE", message: "还没有估价" } },
        },
      },
    );
    await open();
    expect(await screen.findByText(/正在估价/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新估价" })).toBeInTheDocument();
  });

  it("写稿前的排队（还没通过素材）：没有估价卡", async () => {
    stub(state({ variant: variant(2, { status: "queued", name: "手机排行" }), assets: [] }));
    await open();
    await screen.findByRole("region", { name: "素材审核：手机排行" });
    expect(screen.queryByRole("region", { name: "出片估价" })).toBeNull();
  });

  it("限额内自动放行、还在排队等出片：估价卡写明将自动出片", async () => {
    const est = estimateRecord({ productionId: "v2", totalUsd: 0.9, decision: "auto" });
    stub(state({ variant: variant(2, { status: "queued", name: "手机排行", approved: true, estimate: est }) }), {
      "/api/productions/:id/estimate": { body: { estimate: est } },
    });
    await open();
    expect(await screen.findByText(/将自动出片/)).toBeInTheDocument();
  });

  it("出片失败：出片卡给重试出片，不挂估价卡的重新估价（服务端会拒）", async () => {
    const build = buildView({ productionId: "v2" });
    const est = estimateRecord({ productionId: "v2" });
    stub(state({ variant: variant(2, { status: "failed", name: "手机排行", approved: true, estimate: est, build }) }), {
      "/api/productions/:id/estimate": { body: { estimate: est } },
      "/api/productions/:id/build": { body: { build } },
    });
    await open();
    expect(await screen.findByRole("button", { name: "重试出片" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新估价" })).toBeNull();
  });

  it("素材通过提交中：替换入口不可用", async () => {
    stub(state());
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/approve")) return new Promise<Response>(() => undefined);
      return inner(input, init);
    });
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: "素材通过" }));
    await waitFor(() => expect(screen.queryByLabelText("替换 条目 1")).toBeNull());
  });
});

describe("一个动作成功后清掉别的旧错误", () => {
  it("素材通过被拒、之后打回成功：不再显示「素材没通过」", async () => {
    stub(state(), {
      "POST /api/variants/:id/approve": { status: 409, body: { error: { code: "X", message: "不行" } } },
      "POST /api/variants/:id/rework": { body: state() },
    });
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: "素材通过" }));
    expect(await screen.findByText("素材没通过：不行")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打回" }));
    await user.type(screen.getByLabelText("打回意见"), "换图");
    await user.click(screen.getByRole("button", { name: "提交打回" }));
    await waitFor(() => expect(screen.queryByText("素材没通过：不行")).toBeNull());
  });
});

describe("从队列点开", () => {
  it("点队列里的一行：面板打开，焦点落在标题上", async () => {
    stub(state());
    const { user, router } = await mountVariants();
    await user.click(await screen.findByRole("link", { name: "打开变体 手机排行" }));
    await waitFor(() => expect(router.state.location.search).toBe("?variant=v2"));
    const heading = await screen.findByRole("heading", { name: "手机排行" });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("写了一半的 brief 与筛选在打开 / 返回之间保留；返回后焦点回到那一行（8.4 第二轮审查 S2-M-A）", async () => {
    stub(state());
    const { user, router } = await mountVariants();
    await user.click(await screen.findByRole("button", { name: "提交批量变体" }));
    await user.type(screen.getByLabelText("Brief（一行一条）"), "换成手机品牌排行榜");
    await user.click(screen.getByRole("button", { name: "需要我处理 1" }));
    await user.click(screen.getByRole("link", { name: "打开变体 手机排行" }));
    await screen.findByRole("heading", { name: "手机排行" });
    await user.click(screen.getByRole("button", { name: "返回队列" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.getByLabelText("Brief（一行一条）")).toHaveValue("换成手机品牌排行榜");
    expect(screen.getByRole("button", { name: "需要我处理 1" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByRole("link", { name: "打开变体 手机排行" })).toHaveFocus());
  });
});
