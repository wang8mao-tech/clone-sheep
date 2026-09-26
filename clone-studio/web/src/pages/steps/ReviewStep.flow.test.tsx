import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { routeConfig } from "../../app/routes.js";
import { agentJob } from "../../test/agent-fixtures.js";
import { drawerBackend, TPL } from "../../test/agent-drawer-kit.js";
import { installEventSource } from "../../test/fake-event-source.js";
import { healthStubs, renderWithProviders } from "../../test/harness.js";

/**
 * ③ 验货在整个应用外壳里（布局按模板状态锁步骤、会重定向）：通过验货后要真的停在 ④，
 * 不能被布局拿旧的模板状态送回 ③（7.3 审查 HIGH-1）。模板详情接口故意慢 60 毫秒，像真网络那样。
 */

const CLIENT = "c1";
let findSource: ReturnType<typeof installEventSource>;
beforeEach(() => {
  findSource = installEventSource();
});

function backend() {
  const db = { status: "awaiting_review" as string };
  const client = { id: CLIENT, name: "老王工作室", createdAt: "2026-09-20T04:10:35.093Z" };
  const detail = () => ({
    id: TPL,
    clientId: CLIENT,
    name: "足球榜单",
    status: db.status,
    language: "zh",
    note: null,
    sourceKind: "file",
    sourceUrl: null,
    hasSource: true,
    evidenceStatus: "done",
    workspacePath: "C:/data/x",
    createdAt: "2026-09-20T04:10:35.093Z",
    updatedAt: "2026-09-20T04:10:35.093Z",
    client,
    stats: { outputs: 0, totalCostUsd: 0, costIsEstimate: false, lastActivityAt: "2026-09-20T04:10:35.093Z" },
  });
  const review = () => ({
    templateId: TPL,
    templateStatus: db.status,
    approvedReplicaId: db.status === "approved" ? "p1" : null,
    versions: [
      {
        id: "p1",
        version: 1,
        status: "done",
        createdAt: "",
        build: { id: "b1", status: "done", errorCode: null, endedAt: "" },
        videoUrl: "/api/productions/p1/video",
        outputDeleted: false,
      },
    ],
    approvable: db.status === "awaiting_review",
    reworkable: db.status === "awaiting_review",
    nextRound: 2,
  });
  drawerBackend(
    { job: agentJob({ status: "done" }) },
    {
      ...healthStubs,
      "/api/clients": {
        body: { clients: [{ ...client, templates: [{ id: TPL, name: "足球榜单", status: "awaiting_review" }] }] },
      },
      [`/api/templates/${TPL}`]: () => ({ body: detail() }),
      [`/api/templates/${TPL}/review`]: () => ({ body: review() }),
      [`/api/templates/${TPL}/evidence`]: {
        body: { templateId: TPL, status: "done", steps: [{ step: "fetch", status: "done", endedAt: "x" }] },
      },
      [`POST /api/templates/${TPL}/approve`]: () => {
        db.status = "approved";
        return { body: review() };
      },
    },
  );
  // 模板详情慢 60 毫秒：重拉还没回来时布局手里只有旧状态
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.split("?")[0] === `/api/templates/${TPL}`) await new Promise((r) => setTimeout(r, 60));
    return inner(input, init);
  });
}

describe("通过验货后停在 ④（整页）", () => {
  it("模板详情晚回来：仍然停在 ④ 变体，不被送回 ③", async () => {
    backend();
    const router = createMemoryRouter(routeConfig, { initialEntries: [`/clients/${CLIENT}/templates/${TPL}/review`] });
    renderWithProviders(<RouterProvider router={router} />);
    act(() => findSource(`template:${TPL}`)?.open());
    const seen: string[] = [];
    router.subscribe((s) => seen.push(s.location.pathname.split("/").at(-1) ?? ""));

    await userEvent.click(await screen.findByRole("button", { name: "通过验货" }));
    await waitFor(() => expect(seen).toContain("variants"));
    // 等模板详情重拉回来，再确认没被弹回去
    await new Promise((r) => setTimeout(r, 200));
    expect(router.state.location.pathname).toBe(`/clients/${CLIENT}/templates/${TPL}/variants`);
    expect(seen).not.toContain("review");
  });
});
