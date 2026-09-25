import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { AgentFeedProvider } from "../lib/AgentFeedProvider.js";
import type { BuildView } from "../lib/build.js";
import type { EstimateRecord } from "../lib/estimate.js";
import type { BatchView, VariantView } from "../lib/variants.js";
import { VariantsStep } from "../pages/steps/VariantsStep.js";
import { agentJob } from "./agent-fixtures.js";
import { drawerBackend, TPL } from "./agent-drawer-kit.js";
import { installEventSource } from "./fake-event-source.js";
import { renderWithProviders } from "./harness.js";
import { DS, SUB } from "./profiles-kit.js";

/** ④ 变体页测试共用：变体 / 批次桩、假后端（队列、提交、取消、重跑、重试出片、继续）、挂在带抽屉数据源的路由里 */

type Stubs = NonNullable<Parameters<typeof drawerBackend>[1]>;

let findSource: ReturnType<typeof installEventSource> = () => undefined;
export function installVariantSources(): void {
  findSource = installEventSource();
}
export const templateSource = () => findSource(`template:${TPL}`);

export const variant = (n: number, over: Partial<VariantView> = {}): VariantView => ({
  id: `v${n}`,
  batchId: "b1",
  name: `换成第 ${n} 个品牌的排行`,
  brief: `换成第 ${n} 个品牌的排行榜`,
  status: "queued",
  createdAt: "2026-09-24T08:00:00.000Z",
  updatedAt: "2026-09-24T08:00:00.000Z",
  agent: null,
  estimate: null,
  build: null,
  needsMe: false,
  ...over,
  // 服务端只在有运行文件时才给估价与出片（variants.ts presentVariant）：有它们就是交给过出片，默认 approved；
  // 重跑后运行文件清掉的场景，用例自己给 approved: false
  approved: over.approved ?? (over.build != null || over.estimate != null),
});

export const buildView = (over: Partial<BuildView> = {}): BuildView => ({
  id: "bd1",
  productionId: "v1",
  status: "failed",
  hypitBuildId: "bld_x",
  estimateUsd: 0,
  receiptId: null,
  receiptUrl: null,
  errorCode: "BUILD_FAILED",
  errorMessage: "渲染炸了",
  outputPath: null,
  startedAt: "2026-09-24T08:00:00.000Z",
  endedAt: "2026-09-24T08:01:00.000Z",
  createdAt: "2026-09-24T08:00:00.000Z",
  context: null,
  progress: null,
  activity: null,
  ...over,
});

export const estimateRecord = (over: Partial<EstimateRecord> = {}): EstimateRecord => ({
  id: "e1",
  productionId: "v1",
  kind: "ok",
  totalUsd: 0,
  lines: [],
  reason: null,
  decision: "auto",
  reasons: [],
  confirmedAt: null,
  error: null,
  pricingUrls: [],
  createdAt: "2026-09-24T08:00:00.000Z",
  ...over,
});

export const batch = (over: Partial<BatchView> = {}): BatchView => ({
  id: "b1",
  templateId: TPL,
  note: "毒舌风格",
  targetLanguage: null,
  limitUsd: 15,
  spentUsd: 0,
  halted: false,
  createdAt: "2026-09-24T08:00:00.000Z",
  variants: [variant(1)],
  ...over,
});

export interface VariantsDb {
  batches: BatchView[];
  submits: unknown[];
  cancels: string[];
  reruns: string[];
  retries: string[];
  reads: number;
  /** 抽屉那套假后端的库：继续 / 重跑任务的调用次数在这里 */
  drawer: ReturnType<typeof drawerBackend>["db"] | null;
}

export function variantsBackend(init: BatchView[], extra: Stubs = {}): VariantsDb {
  const db: VariantsDb = { batches: init, submits: [], cancels: [], reruns: [], retries: [], reads: 0, drawer: null };
  const drawer = drawerBackend(
    { job: agentJob({ status: "done" }) },
    {
      [`/api/templates/${TPL}`]: {
        body: { id: TPL, clientId: "c1", name: "足球榜单", status: "approved", language: "zh" },
      },
      "/api/settings": { body: { perItemLimitUsd: 1.5, batchLimitUsd: 15, batchMaxItems: 20, agentBudgetUsd: 5 } },
      // CMP-010：内置订阅（默认）、订阅 · Sonnet、一个还没填 key 的兼容端点（置灰）
      "/api/model-profiles": {
        body: {
          profiles: [
            SUB,
            {
              ...SUB,
              id: "p-sonnet",
              name: "订阅 · Sonnet",
              modelId: "claude-sonnet-5",
              isDefault: false,
              builtin: false,
            },
            { ...DS, id: "p-nokey", name: "没 key 的端点", token: null },
          ],
        },
      },
      [`/api/templates/${TPL}/variants`]: () => {
        db.reads += 1;
        return { body: { batches: db.batches } };
      },
      [`POST /api/templates/${TPL}/batches`]: (req) => {
        db.submits.push(JSON.parse(req?.body as string));
        const created = batch({ id: `b${db.batches.length + 2}`, variants: [variant(9)] });
        db.batches = [created, ...db.batches];
        return { status: 201, body: { batch: created } };
      },
      "POST /api/variants/:id/cancel": (_req, url) => {
        db.cancels.push(url?.split("/")[3] ?? "");
        return { body: { variant: variant(1, { status: "cancelled" }) } };
      },
      "POST /api/variants/:id/rerun": (_req, url) => {
        db.reruns.push(url?.split("/")[3] ?? "");
        return { body: { variant: variant(1) } };
      },
      // 007 右栏的花费明细 CMP-008（Task 9.3）：默认没有花费
      "/api/productions/:id/costs": (_req, url) => ({
        body: { productionId: url?.split("/")[3] ?? "", agent: [], builds: [], totalUsd: 0, totalIsEstimate: false },
      }),
      "POST /api/productions/:id/build/retry": (_req, url) => {
        db.retries.push(url?.split("/")[3] ?? "");
        return { body: { queued: true } };
      },
      ...extra,
    },
  );
  db.drawer = drawer.db;
  return db;
}

function Route() {
  const { templateId = "" } = useParams();
  return (
    <AgentFeedProvider templateId={templateId}>
      <VariantsStep />
    </AgentFeedProvider>
  );
}

export async function mountVariants(search = "") {
  const router = createMemoryRouter([{ path: "/clients/:clientId/templates/:templateId/:step", element: <Route /> }], {
    initialEntries: [`/clients/c1/templates/${TPL}/variants${search}`],
  });
  renderWithProviders(<RouterProvider router={router} />);
  act(() => templateSource()?.open());
  await screen.findByRole("region", { name: "④ 变体 工作区" });
  return { router, user: userEvent.setup() };
}
