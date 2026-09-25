import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { AgentFeedProvider } from "../lib/AgentFeedProvider.js";
import type { OutputCosts, OutputView } from "../lib/outputs.js";
import { OutputsStep } from "../pages/steps/OutputsStep.js";
import { agentJob } from "./agent-fixtures.js";
import { drawerBackend, TPL } from "./agent-drawer-kit.js";
import { installEventSource } from "./fake-event-source.js";
import { renderWithProviders } from "./harness.js";
import { buildView } from "./variants-kit.js";

/** ⑤ 成片页测试共用：成片桩、花费明细桩、假后端（列表、改名、花费、删除、重试出片），挂在带抽屉数据源的路由里 */

type Stubs = NonNullable<Parameters<typeof drawerBackend>[1]>;

let findSource: ReturnType<typeof installEventSource> = () => undefined;
export function installOutputSources(): void {
  findSource = installEventSource();
}
export const templateSource = () => findSource(`template:${TPL}`);

export const output = (n: number, over: Partial<OutputView> = {}): OutputView => ({
  id: `p${n}`,
  kind: "variant",
  name: `成片 ${n}`,
  version: 1,
  status: "done",
  supersededBy: null,
  approved: false,
  durationS: 9,
  coverUrl: `/api/productions/p${n}/cover?v=b${n}`,
  costUsd: 0.8,
  costIsEstimate: true,
  downloadable: true,
  retryable: false,
  stop: null,
  build: buildView({ productionId: `p${n}`, status: "done", errorCode: null, errorMessage: null }),
  createdAt: "2026-09-25T08:00:00.000Z",
  updatedAt: "2026-09-25T08:00:00.000Z",
  ...over,
  // 原始状态默认跟卡片状态走（服务端就是这么映射的：pending 只来自流水线里的状态，默认当排队）；要熔断之类的用例自己给
  productionStatus: over.productionStatus ?? (over.status === "pending" ? "queued" : (over.status ?? "done")),
});

export const costs = (over: Partial<OutputCosts> = {}): OutputCosts => ({
  productionId: "p1",
  agent: [
    {
      jobId: "j1",
      model: "claude-sonnet-5",
      status: "done",
      elapsedMs: 220_000,
      costUsd: 0.8,
      isEstimate: true,
      shared: false,
      createdAt: "2026-09-25T08:00:00.000Z",
    },
  ],
  builds: [
    {
      buildId: "b1",
      hypitBuildId: "bld_abc",
      channel: null,
      model: null,
      status: "done",
      codexImages: null,
      estimateUsd: 0,
      actualUsd: null,
      costUsd: 0,
      isEstimate: true,
      receiptId: null,
      receiptUrl: null,
      createdAt: "2026-09-25T08:01:00.000Z",
    },
  ],
  totalUsd: 0.8,
  totalIsEstimate: true,
  ...over,
});

export interface OutputsDb {
  outputs: OutputView[];
  renames: Array<{ id: string; name: string }>;
  deletes: string[];
  retries: string[];
  reads: number;
}

export function outputsBackend(init: OutputView[], extra: Stubs = {}): OutputsDb {
  const db: OutputsDb = { outputs: init, renames: [], deletes: [], retries: [], reads: 0 };
  drawerBackend(
    { job: agentJob({ status: "done" }) },
    {
      [`/api/templates/${TPL}`]: {
        body: { id: TPL, clientId: "c1", name: "足球榜单", status: "approved", language: "zh" },
      },
      [`/api/templates/${TPL}/outputs`]: () => {
        db.reads += 1;
        return { body: { outputs: db.outputs } };
      },
      "PATCH /api/productions/:id": (req, url) => {
        const id = url?.split("/")[3] ?? "";
        const { name } = JSON.parse(req?.body as string) as { name: string };
        db.renames.push({ id, name });
        db.outputs = db.outputs.map((o) => (o.id === id ? { ...o, name: name.trim() } : o));
        return { body: { id, name: name.trim() } };
      },
      "/api/productions/:id/costs": (_req, url) => ({ body: costs({ productionId: url?.split("/")[3] ?? "" }) }),
      "DELETE /api/productions/:id/output": (_req, url) => {
        const id = url?.split("/")[3] ?? "";
        db.deletes.push(id);
        db.outputs = db.outputs.filter((o) => o.id !== id);
        return { body: { removed: 2, skipped: 0 } };
      },
      "POST /api/productions/:id/build/retry": (_req, url) => {
        db.retries.push(url?.split("/")[3] ?? "");
        return { body: { queued: true } };
      },
      ...extra,
    },
  );
  return db;
}

function Route() {
  const { templateId = "" } = useParams();
  return (
    <AgentFeedProvider templateId={templateId}>
      <OutputsStep />
    </AgentFeedProvider>
  );
}

export async function mountOutputs() {
  const router = createMemoryRouter([{ path: "/clients/:clientId/templates/:templateId/:step", element: <Route /> }], {
    initialEntries: [`/clients/c1/templates/${TPL}/outputs`],
  });
  renderWithProviders(<RouterProvider router={router} />);
  act(() => templateSource()?.open());
  await screen.findByRole("region", { name: "⑤ 成片 工作区" });
  return { router, user: userEvent.setup() };
}
