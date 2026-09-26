import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { VariantReviewState } from "../../lib/variant-review.js";
import { TPL } from "../../test/agent-drawer-kit.js";
import {
  batch,
  installVariantSources,
  mountVariants,
  templateSource,
  variant,
  variantsBackend,
} from "../../test/variants-kit.js";

/** SCREEN-007 的 Phase 8 交接项（Task 9.3）：加载骨架、别的模板的变体按不存在处理、右栏 CMP-008 花费明细 */

beforeEach(() => {
  installVariantSources();
});

const state = (over: Partial<VariantReviewState> = {}): VariantReviewState => ({
  templateId: TPL,
  variant: variant(2, { status: "asset_review", needsMe: true, name: "手机排行" }),
  assets: [],
  script: "台词",
  scriptTruncated: false,
  perItemLimitUsd: 1.5,
  batch: null,
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

describe("007 交接项", () => {
  it("加载中：素材与右栏的骨架，不是一行字", async () => {
    stub(state());
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/review")) return new Promise<Response>(() => undefined);
      return inner(input, init);
    });
    await mountVariants("?variant=v2");
    expect(await screen.findByRole("region", { name: "读取素材" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("读取素材…")).toBeNull();
  });

  it("地址里的变体属于别的模板：写明不在这个模板下，不打开它的面板", async () => {
    stub(state({ templateId: "another-template" }));
    await mountVariants("?variant=v2");
    expect(await screen.findByText("这条变体不在这个模板下。")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "素材审核：手机排行" })).toBeNull();
    expect(screen.getByRole("button", { name: "返回队列" })).toBeInTheDocument();
  });

  it("右栏有花费明细 CMP-008（Agent 任务、出片两张表与合计）", async () => {
    stub(state(), {
      "/api/productions/:id/costs": {
        body: {
          productionId: "v2",
          agent: [
            {
              jobId: "j1",
              model: "claude-sonnet-5",
              status: "done",
              elapsedMs: 60_000,
              costUsd: 0.8,
              isEstimate: true,
              shared: false,
              createdAt: "2026-09-25T08:00:00.000Z",
            },
          ],
          builds: [],
          totalUsd: 0.8,
          totalIsEstimate: true,
        },
      },
    });
    await mountVariants("?variant=v2");
    const panel = await screen.findByRole("region", { name: "素材审核：手机排行" });
    const costs = await within(panel).findByRole("region", { name: "花费明细" });
    expect(await within(costs).findByRole("table", { name: "Agent 任务花费" })).toHaveTextContent("$0.80估");
    expect(within(costs).getByText("还没有出过片。")).toBeInTheDocument();
  });
});

describe("007 的花费明细跟着更新（9.3 审查 S1-M3）", () => {
  it("后端推 build：右栏花费明细重拉", async () => {
    let reads = 0;
    stub(state(), {
      "/api/productions/:id/costs": () => {
        reads += 1;
        return { body: { productionId: "v2", agent: [], builds: [], totalUsd: 0, totalIsEstimate: false } };
      },
    });
    await mountVariants("?variant=v2");
    const panel = await screen.findByRole("region", { name: "素材审核：手机排行" });
    await within(panel).findByText("还没有出过片。");
    const before = reads;
    act(() => templateSource()?.emit("build", `template:${TPL}`, {}));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });
});
