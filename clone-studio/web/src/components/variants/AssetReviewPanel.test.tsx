import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { AssetView, VariantReviewState } from "../../lib/variant-review.js";
import { batch, installVariantSources, mountVariants, variant, variantsBackend } from "../../test/variants-kit.js";
import { TPL } from "../../test/agent-drawer-kit.js";

/** SCREEN-007 素材审核全幅面板：角标、来源链接、替换 / 上传、有缺口禁用通过、通过、打回、版权提示（AC-015 / AC-018 前端） */

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

function reviewState(over: Partial<VariantReviewState> = {}): VariantReviewState {
  return {
    templateId: TPL,
    variant: variant(2, { status: "asset_review", needsMe: true, name: "手机排行", brief: "换成手机品牌排行榜" }),
    assets: [
      asset(1),
      asset(2, { sourceUrl: null, sourceHost: null }),
      asset(3, { replaced: true, sourceUrl: null, sourceHost: null }),
      asset(4, { gap: true, sourceUrl: null, sourceHost: null, imageUrl: null }),
    ],
    script: "第一段台词\n\n第二段台词",
    scriptTruncated: false,
    perItemLimitUsd: 1.5,
    batch: { id: "b1", limitUsd: 15, spentUsd: 0 },
    approveBlocked: "还有 1 个缺口没补，先上传",
    reworkBlocked: null,
    ...over,
  };
}

function backend(state: VariantReviewState) {
  const calls = { approve: 0, rework: [] as unknown[], replace: [] as string[] };
  let current = state;
  const db = variantsBackend([batch({ variants: [current.variant] })], {
    "/api/variants/:id/review": () => ({ body: current }),
    "POST /api/variants/:id/approve": () => {
      calls.approve += 1;
      current = { ...current, variant: { ...current.variant, status: "queued", needsMe: false } };
      return { body: current };
    },
    "POST /api/variants/:id/rework": (req) => {
      calls.rework.push(JSON.parse(req?.body as string));
      current = { ...current, variant: { ...current.variant, status: "agent_running" } };
      return { body: current };
    },
    "POST /api/assets/:id/replace": (_req, url) => {
      calls.replace.push(url?.split("/")[3] ?? "");
      current = {
        ...current,
        assets: current.assets.map((a) => (a.id === "a4" ? { ...a, gap: false, replaced: true, imageUrl: "/x" } : a)),
        approveBlocked: null,
      };
      return { body: { asset: current.assets[3] } };
    },
  });
  return { db, calls };
}

const open = () => mountVariants("?variant=v2");

describe("素材网格", () => {
  it("角标：无来源黄、已替换、缺口红；有来源的给来源域名链接（新窗口）；台词按段；版权提示", async () => {
    backend(reviewState());
    await open();
    const panel = await screen.findByRole("region", { name: "素材审核：手机排行" });
    const card = (n: number) => within(panel).getByRole("figure", { name: `素材 条目 ${n}` });
    const link = within(card(1)).getByRole("link", { name: /img1\.example\.com/ });
    expect(link).toHaveAttribute("href", "https://img1.example.com/x");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(card(2)).getByText("无来源")).toBeInTheDocument();
    expect(within(card(3)).getByText("已替换")).toBeInTheDocument();
    expect(within(card(3)).queryByText("无来源")).toBeNull();
    expect(within(card(4)).getByText("缺口")).toBeInTheDocument();
    expect(within(card(4)).getByText("上传")).toBeInTheDocument();
    expect(within(panel).getByText("第一段台词")).toBeInTheDocument();
    expect(within(panel).getByText("第二段台词")).toBeInTheDocument();
    expect(within(panel).getByText("联网图片版权由使用者自行负责。")).toBeInTheDocument();
  });

  it("有缺口：素材通过不可点并写明原因；上传补上缺口后能通过，通过只发一次、不起 Agent（AC-015）", async () => {
    const { calls } = backend(reviewState());
    const { user } = await open();
    const approve = await screen.findByRole("button", { name: "素材通过" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute("title", "还有 1 个缺口没补，先上传");
    const file = new File([new Uint8Array([1, 2, 3])], "new.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("上传 条目 4"), file);
    await waitFor(() => expect(calls.replace).toEqual(["a4"]));
    await waitFor(() => expect(screen.getByRole("button", { name: "素材通过" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "素材通过" }));
    await waitFor(() => expect(calls.approve).toBe(1));
    expect(calls.rework).toEqual([]);
  });

  it("选错类型 / 超过 20 MB：就地红字，不上传", async () => {
    const { calls } = backend(reviewState());
    await open();
    const input = await screen.findByLabelText("替换 条目 1");
    fireEvent.change(input, { target: { files: [new File(["x"], "a.gif", { type: "image/gif" })] } });
    expect(await screen.findByText("只收 jpg / png / webp。")).toBeInTheDocument();
    const big = new File([new Uint8Array(21 * 1024 * 1024)], "big.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/超过 20 MB 上限/)).toBeInTheDocument();
    expect(calls.replace).toEqual([]);
  });

  it("替换被后端拒：那张卡上写明没换成与原因", async () => {
    backend(reviewState());
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/replace")) {
        return new Response(JSON.stringify({ error: { code: "NOT_AN_IMAGE", message: "读不出这张图" } }), {
          status: 400,
        });
      }
      return inner(input, init);
    });
    const { user } = await open();
    await user.upload(await screen.findByLabelText("替换 条目 1"), new File(["x"], "a.png", { type: "image/png" }));
    expect(await screen.findByText("没换成：读不出这张图")).toBeInTheDocument();
  });

  it("看大图：弹出只放这张图的弹层，关闭回来", async () => {
    backend(reviewState());
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: "看大图 条目 1" }));
    const dialog = screen.getByRole("dialog", { name: "大图：条目 1", hidden: true });
    expect(within(dialog).getByRole("img", { name: "条目 1", hidden: true })).toHaveAttribute(
      "src",
      "/api/assets/a1/file?v=1",
    );
    await user.click(within(dialog).getByRole("button", { name: "关闭", hidden: true }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  });
});

describe("动作", () => {
  it("打回：写意见提交，意见原文发出去", async () => {
    const { calls } = backend(reviewState({ approveBlocked: null }));
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: "打回" }));
    await user.type(screen.getByLabelText("打回意见"), "第 3 张换成正面照");
    await user.click(screen.getByRole("button", { name: "提交打回" }));
    await waitFor(() => expect(calls.rework).toEqual([{ note: "第 3 张换成正面照" }]));
  });

  it("不在素材待审（在写稿）：不给通过与打回，也不给替换；没有素材时说一句", async () => {
    backend(reviewState({ variant: variant(2, { status: "agent_running", name: "手机排行" }), assets: [] }));
    await open();
    expect(await screen.findByText("素材在 Agent 写完、宿主核过判据之后出现在这里。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "素材通过" })).toBeNull();
    expect(screen.queryByRole("button", { name: "打回" })).toBeNull();
  });

  it("待确认花费（已过素材审核）：素材只读，不给替换 / 上传", async () => {
    backend(
      reviewState({
        variant: variant(2, { status: "awaiting_cost_confirm", name: "手机排行" }),
        approveBlocked: "只有素材待审的变体能通过",
        reworkBlocked: "只有素材待审的变体能打回",
      }),
    );
    await open();
    await screen.findByRole("region", { name: "素材审核：手机排行" });
    expect(screen.queryByLabelText(/^替换 /)).toBeNull();
    expect(screen.queryByLabelText(/^上传 /)).toBeNull();
    expect(screen.queryByRole("button", { name: "素材通过" })).toBeNull();
  });

  it("素材通过被拒：写明是素材没通过与服务端原因", async () => {
    backend(reviewState({ approveBlocked: null }));
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/approve")) {
        return new Response(JSON.stringify({ error: { code: "ASSETS_HAVE_GAPS", message: "还有 1 个缺口没补" } }), {
          status: 409,
        });
      }
      return inner(input, init);
    });
    const { user } = await open();
    await user.click(await screen.findByRole("button", { name: "素材通过" }));
    expect(await screen.findByText("素材没通过：还有 1 个缺口没补")).toBeInTheDocument();
  });

  it("返回队列：回到 ④ 的队列", async () => {
    backend(reviewState());
    const { user, router } = await open();
    await user.click(await screen.findByRole("button", { name: "返回队列" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(await screen.findByRole("region", { name: "变体队列" })).toBeInTheDocument();
  });

  it("读不到：错误态", async () => {
    variantsBackend([batch()], {
      "/api/variants/:id/review": { status: 500, body: { error: { code: "X", message: "炸了" } } },
    });
    await open();
    expect(await screen.findByText("读不到这条变体的素材")).toBeInTheDocument();
  });
});
