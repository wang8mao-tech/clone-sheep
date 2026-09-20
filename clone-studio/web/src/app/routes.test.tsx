import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { healthStubs, renderApp, stubFetch } from "../test/harness.js";

const CLIENT_ID = "8ba62e60-9ee5-43d5-b021-a1f8f5bf3499";
const TEMPLATE_ID = "a6562a0a-0bab-4484-8aa2-9e2d7127e3a2";

const oneClientWithTemplate = {
  clients: [
    {
      id: CLIENT_ID,
      name: "老王工作室",
      createdAt: "2026-09-20T04:10:35.093Z",
      templates: [{ id: TEMPLATE_ID, name: "足球榜单", status: "importing" }],
    },
  ],
};

const templateDetail = {
  id: TEMPLATE_ID,
  clientId: CLIENT_ID,
  name: "足球榜单",
  status: "importing",
  language: null,
  note: null,
  sourceKind: null,
  sourceUrl: null,
  hasSource: false,
  workspacePath: "C:/data/clients/x/templates/y",
  createdAt: "2026-09-20T04:10:35.093Z",
  updatedAt: "2026-09-20T04:10:35.093Z",
  client: { id: CLIENT_ID, name: "老王工作室", createdAt: "2026-09-20T04:10:35.093Z" },
  stats: { outputs: 0, totalCostUsd: 0, costIsEstimate: false, lastActivityAt: "2026-09-20T04:10:35.093Z" },
};

/** 侧栏在不在，就是"应用外壳还在不在"的判据 */
function shellIsAlive(): boolean {
  return screen.queryByRole("navigation", { name: "客户与模板" }) !== null;
}

beforeEach(() => {
  stubFetch({
    ...healthStubs,
    "/api/clients": { body: oneClientWithTemplate },
    [`/api/templates/${TEMPLATE_ID}`]: { body: templateDetail },
    "/api/templates/:id": { status: 404, body: { error: { code: "TEMPLATE_NOT_FOUND", message: "模板不存在" } } },
  });
});

describe("路由兜底", () => {
  /**
   * 这条钉的是一个真出过的事故：侧栏模板行指向 /clients/:id/templates/:id，
   * 而路由表里没有这个地址、也没有 errorElement，于是 react-router 用内置
   * 错误页顶掉整个 <Shell/>，侧栏一起消失，用户只能按浏览器后退键回来。
   * 把路由表改回只有 "/" 和 "settings"，这条必红。
   */
  it("点侧栏模板行不会把应用外壳打没", async () => {
    renderApp("/");
    expect(await screen.findByRole("link", { name: /足球榜单/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: /足球榜单/ }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "足球榜单" })).toBeInTheDocument());
    expect(shellIsAlive()).toBe(true);
  });

  it("地址完全匹配不上时给兜底页，外壳仍在", async () => {
    renderApp("/根本没有这个地址");
    expect(await screen.findByText("这个地址没有对应的页面")).toBeInTheDocument();
    expect(shellIsAlive()).toBe(true);
  });

  it("模板 id 已经不存在时说清楚，而不是空白或崩掉", async () => {
    renderApp(`/clients/${CLIENT_ID}/templates/已经删了`);
    expect(await screen.findByText("这个模板已经不存在了。")).toBeInTheDocument();
    expect(shellIsAlive()).toBe(true);
  });

  it("兜底页的「回首页」能回去", async () => {
    renderApp("/根本没有这个地址");
    await userEvent.click(await screen.findByRole("button", { name: "回首页" }));
    expect(await screen.findByRole("button", { name: "新建客户" })).toBeInTheDocument();
  });
});
