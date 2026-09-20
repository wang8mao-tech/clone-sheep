import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { healthStubs, renderApp, stubFetch } from "../test/harness.js";

const CLIENT_ID = "8ba62e60-9ee5-43d5-b021-a1f8f5bf3499";
const TPL_A = "a6562a0a-0bab-4484-8aa2-9e2d7127e3a2";
const TPL_B = "951d7de2-8b62-4135-809a-bb58a8019872";

const client = { id: CLIENT_ID, name: "老王工作室", createdAt: "2026-09-20T04:10:35.093Z" };

function template(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    clientId: CLIENT_ID,
    name,
    status: "importing",
    language: null,
    note: null,
    sourceKind: null,
    sourceUrl: null,
    hasSource: false,
    workspacePath: "C:/data/x",
    createdAt: "2026-09-20T04:10:35.093Z",
    updatedAt: "2026-09-20T04:10:35.093Z",
    stats: { outputs: 0, totalCostUsd: 0, costIsEstimate: false, lastActivityAt: new Date().toISOString() },
    ...over,
  };
}

const tree = { clients: [{ ...client, templates: [{ id: TPL_A, name: "足球榜单", status: "importing" }] }] };

function base(extra: Record<string, unknown> = {}) {
  return { ...healthStubs, "/api/clients": { body: tree }, ...extra };
}

beforeEach(() => {
  stubFetch(base({ [`/api/clients/${CLIENT_ID}`]: { body: { client, templates: [] } } }));
});

describe("首页空状态（SCREEN-002）", () => {
  it("没有客户时说没有客户", async () => {
    stubFetch(base({ "/api/clients": { body: { clients: [] } } }));
    renderApp("/");
    expect(await screen.findByText("还没有客户。建一个客户，再往里加参考视频。")).toBeInTheDocument();
  });

  /** 之前这里恒显示「还没有客户」，侧栏里站着客户也照说不误 */
  it("有客户时不能再说「还没有客户」", async () => {
    renderApp("/");
    expect(await screen.findByText("从左侧选一个客户，或者再建一个。")).toBeInTheDocument();
    expect(screen.queryByText(/还没有客户/)).not.toBeInTheDocument();
  });

  it("首页的「新建客户」是能用的，建完直接进那个客户的页面（REQ-001 新建后自动选中）", async () => {
    stubFetch(
      base({
        "POST /api/clients": { status: 201, body: { id: "new-client-id", name: "计生协会", createdAt: "x" } },
        "/api/clients/new-client-id": { body: { client: { id: "new-client-id", name: "计生协会", createdAt: "x" }, templates: [] } },
      }),
    );
    renderApp("/");

    await userEvent.click(await screen.findByRole("button", { name: "新建客户" }));
    await userEvent.type(await screen.findByLabelText("客户名"), "计生协会{Enter}");

    expect(await screen.findByRole("heading", { name: "计生协会" })).toBeInTheDocument();
  });
});

describe("客户页：模板紧凑行列表（CMP-002）", () => {
  it("列出 Design-Brief 点名的那几列：状态点、模板名、成片数、累计花费、最近活动", async () => {
    stubFetch(
      base({
        [`/api/clients/${CLIENT_ID}`]: {
          body: {
            client,
            templates: [
              template(TPL_A, "足球榜单", {
                status: "approved",
                hasSource: true,
                stats: {
                  outputs: 12,
                  totalCostUsd: 3.5,
                  costIsEstimate: false,
                  lastActivityAt: new Date().toISOString(),
                },
              }),
            ],
          },
        },
      }),
    );
    renderApp(`/clients/${CLIENT_ID}`);

    const row = await screen.findByRole("button", { name: "打开模板 足球榜单" });
    expect(within(row).getByText("已验货")).toBeInTheDocument();
    expect(within(row).getByText("12")).toBeInTheDocument();
    expect(within(row).getByText("$3.50")).toBeInTheDocument();
    expect(within(row).getByText("刚刚")).toBeInTheDocument();
  });

  it("含估算的花费带「估」徽标，实际花费不带（REQ-009）", async () => {
    stubFetch(
      base({
        [`/api/clients/${CLIENT_ID}`]: {
          body: {
            client,
            templates: [
              template(TPL_A, "估的", {
                stats: { outputs: 1, totalCostUsd: 1.25, costIsEstimate: true, lastActivityAt: "2026-09-20T04:00:00Z" },
              }),
              template(TPL_B, "实的", {
                stats: { outputs: 1, totalCostUsd: 2.5, costIsEstimate: false, lastActivityAt: "2026-09-20T04:00:00Z" },
              }),
            ],
          },
        },
      }),
    );
    renderApp(`/clients/${CLIENT_ID}`);

    const estimated = await screen.findByRole("button", { name: "打开模板 估的" });
    expect(within(estimated).getByText("估")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "打开模板 实的" })).queryByText("估")).not.toBeInTheDocument();
  });

  it("点一行进模板页", async () => {
    stubFetch(
      base({
        [`/api/clients/${CLIENT_ID}`]: { body: { client, templates: [template(TPL_A, "足球榜单")] } },
        [`/api/templates/${TPL_A}`]: { body: { ...template(TPL_A, "足球榜单"), client } },
      }),
    );
    renderApp(`/clients/${CLIENT_ID}`);

    await userEvent.click(await screen.findByRole("button", { name: "打开模板 足球榜单" }));
    expect(await screen.findByRole("heading", { name: "足球榜单" })).toBeInTheDocument();
  });

  it("客户不存在时说清楚，而不是空白", async () => {
    stubFetch(
      base({
        [`/api/clients/${CLIENT_ID}`]: { status: 404, body: { error: { code: "CLIENT_NOT_FOUND", message: "客户不存在" } } },
      }),
    );
    renderApp(`/clients/${CLIENT_ID}`);
    expect(await screen.findByText("这个客户已经不存在了。")).toBeInTheDocument();
  });
});

describe("客户页：新建模板", () => {
  it("客户下没有模板时主区给「新建模板」（REQ-001 空状态）", async () => {
    renderApp(`/clients/${CLIENT_ID}`);
    expect(await screen.findByText("这个客户下还没有模板。建一个，再导入参考视频。")).toBeInTheDocument();
  });

  it("建模板打到这个客户名下", async () => {
    const post = vi.fn();
    stubFetch(
      base({
        [`/api/clients/${CLIENT_ID}`]: { body: { client, templates: [] } },
        [`POST /api/clients/${CLIENT_ID}/templates`]: (init?: RequestInit) => {
          post(init?.body);
          return { status: 201, body: template("新模板", "足球榜单") };
        },
      }),
    );
    renderApp(`/clients/${CLIENT_ID}`);

    await userEvent.click((await screen.findAllByRole("button", { name: "新建模板" }))[0] as HTMLElement);
    await userEvent.type(await screen.findByLabelText("模板名"), "足球榜单{Enter}");

    await waitFor(() => expect(post).toHaveBeenCalledWith(JSON.stringify({ name: "足球榜单" })));
  });

  /** AC-003：同客户下已有「足球榜」，再建同名要在输入框下提示「名称已存在」且不创建 */
  it("同客户下重名时红字贴在输入框下", async () => {
    stubFetch(
      base({
        [`/api/clients/${CLIENT_ID}`]: { body: { client, templates: [template(TPL_A, "足球榜")] } },
        [`POST /api/clients/${CLIENT_ID}/templates`]: {
          status: 409,
          body: { error: { code: "NAME_TAKEN", message: "名称已存在" } },
        },
      }),
    );
    renderApp(`/clients/${CLIENT_ID}`);

    await userEvent.click(await screen.findByRole("button", { name: "新建模板" }));
    await userEvent.type(await screen.findByLabelText("模板名"), "足球榜{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("名称已存在");
    expect(screen.getByLabelText("模板名")).toBeInTheDocument();
  });
});
