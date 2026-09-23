import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EstimateCard } from "./EstimateCard.js";
import type { EstimateRecord } from "../../lib/estimate.js";
import { renderWithProviders, stubFetch, type RouteStub } from "../../test/harness.js";

/** CMP-006 估价 / 限额卡：auto / confirm / blocked / 拿不到四态、确认出片、重新估价、估价还没出来时轮询 */

const PID = "prod-1";

function estimate(over: Partial<EstimateRecord> = {}): EstimateRecord {
  return {
    id: "e1",
    productionId: PID,
    kind: "ok",
    totalUsd: 0.92,
    lines: [
      {
        capability: "@hypit/seedance@1#seedance-2-mini",
        endpoint: "tokendance.default",
        count: 2,
        unit: "request",
        unitUsd: 0.28,
        usd: 0.56,
        local: false,
        pricingUrl: "https://tokendance.space/models",
        missing: null,
      },
      {
        capability: "@hypit/render-hyperframes@1#render-visual",
        endpoint: "hyperframes.local",
        count: 1,
        unit: null,
        unitUsd: 0,
        usd: 0,
        local: true,
        pricingUrl: null,
        missing: null,
      },
    ],
    reason: null,
    decision: "auto",
    reasons: [],
    confirmedAt: null,
    error: null,
    pricingUrls: ["https://tokendance.space/models"],
    createdAt: "2026-09-23T10:00:00.000Z",
    ...over,
  };
}

function backend(current: () => RouteStub) {
  const calls = { confirm: 0, reestimate: 0 };
  stubFetch({
    [`/api/productions/${PID}/estimate`]: current,
    [`POST /api/productions/${PID}/confirm-cost`]: () => {
      calls.confirm += 1;
      return {
        body: {
          estimate: estimate({
            decision: "confirm",
            reasons: ["over_item_limit"],
            totalUsd: 2.1,
            confirmedAt: "2026-09-23T10:01:00.000Z",
          }),
        },
      };
    },
    [`POST /api/productions/${PID}/estimate`]: () => {
      calls.reestimate += 1;
      return { body: { estimate: estimate({ totalUsd: 0.3 }) } };
    },
  });
  return calls;
}

const mount = () => renderWithProviders(<EstimateCard productionId={PID} perItemLimitUsd={1.5} />);

describe("四态", () => {
  it("限额内：金额、明细（本地标出）、价格页链接、「将自动出片」，没有确认按钮", async () => {
    backend(() => ({ body: { estimate: estimate() } }));
    mount();
    await screen.findByText("$0.92");
    const card = screen.getByRole("region", { name: "出片估价" });
    expect(within(card).getByText("限额内")).toBeTruthy();
    expect(within(card).getByText(/seedance-2-mini ×2/)).toBeTruthy();
    // 本地零价合成一行（设计稿：本地渲染 / ffmpeg $0.00）
    expect(within(card).getByText("本地渲染 / ffmpeg")).toBeTruthy();
    expect(within(card).queryByText(/render-visual/)).toBeNull();
    expect(within(card).getByRole("link", { name: "tokendance.space" }).getAttribute("href")).toBe(
      "https://tokendance.space/models",
    );
    expect(within(card).getByText("限额内，将自动出片")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /确认出片/ })).toBeNull();
    // 限额条：$0.92 / $1.50 ≈ 61%，全在限额内，没有琥珀段
    const bar = within(card).getByText("单条限额 $1.50").nextElementSibling as HTMLElement;
    expect(bar.children).toHaveLength(1);
    expect((bar.children[0] as HTMLElement).style.width).toBe("61%");
  });

  it("超限的限额条：限额内那段强调色 71%，超出的 29% 琥珀；多个价格页链接用顿号隔开", async () => {
    backend(() => ({
      body: {
        estimate: estimate({
          decision: "confirm",
          reasons: ["over_item_limit"],
          totalUsd: 2.1,
          pricingUrls: ["https://tokendance.space/models", "https://hypit.ai/pricing"],
        }),
      },
    }));
    mount();
    await screen.findByText("$2.10");
    const card = screen.getByRole("region", { name: "出片估价" });
    const bar = within(card).getByText("单条限额 $1.50").nextElementSibling as HTMLElement;
    expect(bar.children).toHaveLength(2);
    expect((bar.children[0] as HTMLElement).style.width).toBe("71%");
    expect((bar.children[1] as HTMLElement).style.width).toBe("29%");
    expect((bar.children[1] as HTMLElement).className).toContain("bg-warning");
    expect(card.textContent).toContain("tokendance.space、hypit.ai");
  });

  it("超单条限额：待确认徽标、原因、主按钮带金额；点确认后变「已确认」", async () => {
    const calls = backend(() => ({
      body: { estimate: estimate({ decision: "confirm", reasons: ["over_item_limit"], totalUsd: 2.1 }) },
    }));
    mount();
    await screen.findByText("待确认");
    const card = screen.getByRole("region", { name: "出片估价" });
    expect(within(card).getByText("超过单条限额")).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "确认出片 $2.10" }));
    await waitFor(() => expect(calls.confirm).toBe(1));
    expect(await within(card).findByText("已确认，将出片")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /确认出片/ })).toBeNull();
  });

  it("估价拿不到：金额是「—」，按超限等确认，按钮写明拿不到", async () => {
    backend(() => ({
      body: {
        estimate: estimate({
          totalUsd: null,
          decision: "confirm",
          reasons: ["estimate_unknown"],
          lines: [
            {
              capability: "@hypit/seedance@1#seedance-2-mini",
              endpoint: null,
              count: 1,
              unit: null,
              unitUsd: null,
              usd: null,
              local: false,
              pricingUrl: "https://tokendance.space/models",
              missing: "费率表里没有这个能力的单价",
            },
          ],
        }),
      },
    }));
    mount();
    await screen.findByText("—");
    const card = screen.getByRole("region", { name: "出片估价" });
    expect(within(card).getByText("拿不到")).toBeTruthy();
    expect(within(card).getByText("估价拿不到，按超限处理")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "确认出片 （估价拿不到）" })).toBeTruthy();
  });

  it("有未解析请求：不能出片，原因原样，没有确认按钮", async () => {
    backend(() => ({
      body: {
        estimate: estimate({
          kind: "blocked",
          decision: "blocked",
          totalUsd: null,
          lines: [],
          reason: "有请求没有可用的 Provider：@hypit/tts@1#speak",
          pricingUrls: [],
        }),
      },
    }));
    mount();
    await screen.findByText("不能出片");
    const card = screen.getByRole("region", { name: "出片估价" });
    expect(within(card).getByText("有请求没有可用的 Provider：@hypit/tts@1#speak")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /确认出片/ })).toBeNull();
  });
});

describe("明细折叠与坏链接", () => {
  it("超过 3 项折叠，展开后全显示；价格页 URL 坏了也不崩", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      capability: `@hypit/x@1#cap-${i}`,
      endpoint: null,
      count: 1,
      unit: "request" as const,
      unitUsd: 0.1,
      usd: 0.1,
      local: false,
      pricingUrl: "not a url",
      missing: null,
    }));
    backend(() => ({ body: { estimate: estimate({ lines: many, totalUsd: 0.5, pricingUrls: ["not a url"] }) } }));
    mount();
    await screen.findByText("$0.50");
    const list = screen.getByRole("list", { name: "请求明细" });
    expect(within(list).queryByText("cap-4 ×1")).toBeNull();
    await userEvent.click(within(list).getByRole("button", { name: "展开全部 5 项" }));
    expect(within(list).getByText("cap-4 ×1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "not a url" })).toBeTruthy();
  });
});

describe("重估与等待", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("点「重新估价」：新结论替换旧的", async () => {
    const calls = backend(() => ({
      body: { estimate: estimate({ decision: "confirm", reasons: ["over_item_limit"], totalUsd: 2.1 }) },
    }));
    mount();
    await screen.findByText("$2.10");
    const card = screen.getByRole("region", { name: "出片估价" });
    await userEvent.click(within(card).getByRole("button", { name: "重新估价" }));
    await waitFor(() => expect(calls.reestimate).toBe(1));
    expect(await within(card).findByText("$0.30")).toBeTruthy();
    expect(within(card).getByText("限额内")).toBeTruthy();
  });

  it("估价还没出来（404）：显示正在估价，几秒后再拉，出来了就显示", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let ready = false;
    backend(() =>
      ready
        ? { body: { estimate: estimate() } }
        : { status: 404, body: { error: { code: "NO_ESTIMATE", message: "这条还没有估价" } } },
    );
    mount();
    expect(await screen.findByText(/正在估价/)).toBeTruthy();
    ready = true;
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    expect(await screen.findByText("$0.92")).toBeTruthy();
  });

  it("估价一直没出来：「正在估价」旁边有「重新估价」当出口", async () => {
    const calls = backend(() => ({ status: 404, body: { error: { code: "NO_ESTIMATE", message: "这条还没有估价" } } }));
    mount();
    await screen.findByText(/正在估价/);
    await userEvent.click(screen.getByRole("button", { name: "重新估价" }));
    await waitFor(() => expect(calls.reestimate).toBe(1));
    expect(await screen.findByText("$0.30")).toBeTruthy();
  });

  it("读估价出错（不是 404）：给原文和重试", async () => {
    backend(() => ({ status: 500, body: { error: { message: "炸了" } } }));
    mount();
    expect(await screen.findByText(/读不到估价：炸了/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});
