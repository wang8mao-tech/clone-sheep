import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { AgentFeedProvider } from "../lib/AgentFeedProvider.js";
import type { ReviewState, ReviewVersion } from "../lib/review.js";
import { ReviewStep } from "../pages/steps/ReviewStep.js";
import { agentJob } from "./agent-fixtures.js";
import { drawerBackend, TPL } from "./agent-drawer-kit.js";
import { installEventSource } from "./fake-event-source.js";
import { renderWithProviders } from "./harness.js";

/** ③ 验货页测试共用：验货状态桩、后端桩（可加 / 覆盖接口）、挂在带抽屉数据源的路由里 */

type Stubs = NonNullable<Parameters<typeof drawerBackend>[1]>;

let findSource: ReturnType<typeof installEventSource> = () => undefined;
/** 每个用例的 beforeEach 里调：装假 EventSource */
export function installReviewSources(): void {
  findSource = installEventSource();
}

export const version = (n: number, over: Partial<ReviewVersion> = {}): ReviewVersion => ({
  id: `p${n}`,
  version: n,
  status: "done",
  createdAt: "",
  build: { id: `b${n}`, status: "done", errorCode: null, endedAt: "" },
  videoUrl: `/api/productions/p${n}/video`,
  ...over,
});

export const state = (over: Partial<ReviewState> = {}): ReviewState => ({
  templateId: TPL,
  templateStatus: "awaiting_review",
  approvedReplicaId: null,
  versions: [version(1)],
  approvable: true,
  reworkable: true,
  nextRound: 2,
  ...over,
});

export function backend(init: ReviewState, extra: Stubs = {}) {
  const db = { review: init, reads: 0, approved: [] as unknown[], reworks: [] as unknown[] };
  drawerBackend(
    { job: agentJob({ status: "done" }) },
    {
      [`/api/templates/${TPL}/review`]: () => {
        db.reads += 1;
        return { body: db.review };
      },
      [`/api/templates/${TPL}/evidence`]: {
        body: {
          templateId: TPL,
          status: "done",
          steps: [{ step: "fetch", status: "done", endedAt: "2026-09-23T10:00:00.000Z" }],
          probe: { frameRate: 25 },
        },
      },
      [`POST /api/templates/${TPL}/approve`]: (init) => {
        db.approved.push(JSON.parse(init?.body as string));
        db.review = { ...db.review, templateStatus: "approved", approvedReplicaId: "p1", approvable: false };
        return { body: db.review };
      },
      [`POST /api/templates/${TPL}/rework`]: (init) => {
        db.reworks.push(JSON.parse(init?.body as string));
        return { body: { job: agentJob({ status: "queued" }), review: { ...db.review, templateStatus: "cloning" } } };
      },
      "/api/productions/:id/build": {
        body: {
          build: {
            id: "b2",
            productionId: "p2",
            status: "failed",
            hypitBuildId: null,
            estimateUsd: 0,
            receiptId: null,
            receiptUrl: null,
            errorCode: "BUILD_FAILED",
            errorMessage: "渲染炸了",
            outputPath: null,
            startedAt: null,
            endedAt: null,
            createdAt: "",
            context: null,
            activity: null,
            progress: null,
          },
        },
      },
      ...extra,
    },
  );
  return db;
}

function Route() {
  const { templateId = "", step } = useParams();
  return (
    <AgentFeedProvider templateId={templateId}>
      {step === "review" ? <ReviewStep /> : <p>到了 {step}</p>}
    </AgentFeedProvider>
  );
}

export async function mount() {
  const router = createMemoryRouter([{ path: "/clients/:clientId/templates/:templateId/:step", element: <Route /> }], {
    initialEntries: [`/clients/c1/templates/${TPL}/review`],
  });
  renderWithProviders(<RouterProvider router={router} />);
  act(() => findSource(`template:${TPL}`)?.open());
  await screen.findByRole("region", { name: "③ 验货 工作区" });
  return { router, user: userEvent.setup() };
}

export const rightVideo = (label: string) => screen.findByLabelText<HTMLVideoElement>(label, { selector: "video" });
