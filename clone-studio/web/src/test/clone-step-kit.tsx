import { beforeEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { AgentFeedProvider } from "../lib/AgentFeedProvider.js";
import type { CloneState } from "../lib/clone.js";
import { agentJob } from "./agent-fixtures.js";
import { drawerBackend, TPL } from "./agent-drawer-kit.js";
import { ControlledEventSource, installEventSource } from "./fake-event-source.js";
import { renderWithProviders, type RouteStub } from "./harness.js";
import { CloneStep } from "../pages/steps/CloneStep.js";

/**
 * ② 复刻页测试的公共底座：假后端（clone / evidence / 手动开始 + 抽屉那套）、带路由的挂载、
 * 往模板主题推事件。只桩 fetch 与 EventSource，其余全是真的。
 */

export { TPL, agentJob };

let findSource: ReturnType<typeof installEventSource>;
let estimateStub: RouteStub | undefined;
let buildStub: RouteStub | undefined;

/** 让估价接口从「还没估出来」变成有结论 */
export function stubEstimate(estimate: unknown): void {
  estimateStub = { body: { estimate } };
}

/** 让出片接口给某个 build 记录 */
export function stubBuild(build: unknown): void {
  buildStub = { body: { build } };
}

export function setupCloneStep(): void {
  beforeEach(() => {
    findSource = installEventSource();
    estimateStub = undefined;
    buildStub = undefined;
  });
}

export const source = (topic: string) => findSource(topic);

export const EMPTY: CloneState = {
  templateId: TPL,
  analysis: null,
  timeline: null,
  svrunExists: false,
  verdict: null,
  verifying: false,
  replica: null,
};

export const EVIDENCE_DONE = {
  templateId: TPL,
  status: "done",
  steps: [{ step: "fetch", status: "done", endedAt: "2026-09-23T10:00:00.000Z" }],
};

export const EVIDENCE_FETCHING = { ...EVIDENCE_DONE, status: "running", steps: [{ step: "fetch", status: "running" }] };

interface Backend {
  clone: CloneState;
  startCalls: number;
  /** GET /clone 被拉了几次：验轮询开没开 */
  cloneReads: number;
  estimateReads: number;
  buildReads: number;
}

export function backend(
  init: {
    clone?: CloneState;
    job?: ReturnType<typeof agentJob> | null;
    start?: RouteStub;
    evidence?: RouteStub;
    estimate?: RouteStub;
  } = {},
) {
  const state: Backend = { clone: init.clone ?? EMPTY, startCalls: 0, cloneReads: 0, estimateReads: 0, buildReads: 0 };
  const drawer = drawerBackend(
    { job: init.job === undefined ? agentJob({ status: "running" }) : init.job },
    {
      [`/api/templates/${TPL}/clone`]: () => {
        state.cloneReads += 1;
        return { body: state.clone };
      },
      [`/api/templates/${TPL}/evidence`]: init.evidence ?? { body: EVIDENCE_DONE },
      // 估价卡要画单条限额；复刻片排上队后卡片会拉它的估价
      "/api/settings": { body: { perItemLimitUsd: 1.5, batchLimitUsd: 15, agentBudgetUsd: 5 } },
      "/api/productions/:id/estimate": () => {
        state.estimateReads += 1;
        return (
          estimateStub ??
          init.estimate ?? { status: 404, body: { error: { code: "NO_ESTIMATE", message: "这条还没有估价" } } }
        );
      },
      "/api/productions/:id/build": () => {
        state.buildReads += 1;
        return buildStub ?? { status: 404, body: { error: { code: "NO_BUILD", message: "这条还没有出过片" } } };
      },
      // 换模板的用例要切到 tpl-2：它也得是一个正常打开的页面，不然错误态会把上一个模板的残留一起盖掉
      "/api/templates/tpl-2/clone": { body: { ...EMPTY, templateId: "tpl-2" } },
      "/api/templates/tpl-2/evidence": { body: { ...EVIDENCE_DONE, templateId: "tpl-2" } },
      "/api/templates/tpl-2/agent-job": {
        body: {
          job: null,
          messages: [],
          hasOlder: false,
          hasNewer: false,
          firstSeq: 0,
          lastSeq: 0,
          nextSeq: 0,
          jobLastSeq: 0,
        },
      },
      [`POST /api/templates/${TPL}/clone`]: () => {
        state.startCalls += 1;
        if (init.start) return init.start;
        drawer.db.job = agentJob({ status: "queued" });
        return { body: { job: drawer.db.job } };
      },
    },
  );
  return { state, drawer };
}

/** 和外壳一样：Provider 的模板 id 从地址里来，换模板时 Provider 与页面一起换 */
function Route() {
  const { templateId = "" } = useParams();
  return (
    <AgentFeedProvider templateId={templateId}>
      <CloneStep />
    </AgentFeedProvider>
  );
}

export async function mount(templateId = TPL) {
  const router = createMemoryRouter([{ path: "/clients/:clientId/templates/:templateId/:step", element: <Route /> }], {
    initialEntries: [`/clients/c1/templates/${templateId}/clone`],
  });
  renderWithProviders(<RouterProvider router={router} />);
  act(() => findSource(`template:${templateId}`)?.open());
  return router;
}

export const file = (text: string) => ({ text, truncated: false });

/** 让模板快照接口按条件失败：模拟「后端未响应」那一刻，其余接口照旧 */
export function stubSnapshotFailure(shouldFail: () => boolean): void {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/agent-job") && shouldFail()) {
      return new Response(JSON.stringify({ error: { message: "后端未响应" } }), { status: 504 });
    }
    return real(input, init);
  });
}

/** 后端往模板主题推一条事件：模板主题的连接（抽屉那条）都要收到 */
export function pushTemplateEvent(event: string, data: unknown = {}): void {
  act(() => {
    for (const es of ControlledEventSource.instances) {
      if (!es.closed && es.topics.includes(`template:${TPL}`)) es.emit(event, `template:${TPL}`, data);
    }
  });
}

/** 判据结论出来了 */
export const pushClone = (): void => pushTemplateEvent("clone");
