import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { healthStubs, renderApp, stubFetch } from "../test/harness.js";
import type { TemplateStatus } from "../lib/archive.js";

const CLIENT_ID = "8ba62e60-9ee5-43d5-b021-a1f8f5bf3499";
const TPL_ID = "a6562a0a-0bab-4484-8aa2-9e2d7127e3a2";
const BASE = `/clients/${CLIENT_ID}/templates/${TPL_ID}`;

const client = { id: CLIENT_ID, name: "老王工作室", createdAt: "2026-09-20T04:10:35.093Z" };
const tree = { clients: [{ ...client, templates: [{ id: TPL_ID, name: "足球榜单", status: "importing" }] }] };

function detail(status: TemplateStatus, over: { hasSource?: boolean; outputs?: number; cost?: number } = {}) {
  return {
    id: TPL_ID,
    clientId: CLIENT_ID,
    name: "足球榜单",
    status,
    language: null,
    note: null,
    sourceKind: null,
    sourceUrl: null,
    hasSource: over.hasSource ?? true,
    evidenceStatus: status === "importing" ? "running" : "done",
    workspacePath: "C:/data/x",
    createdAt: "2026-09-20T04:10:35.093Z",
    updatedAt: "2026-09-20T04:10:35.093Z",
    client,
    stats: {
      outputs: over.outputs ?? 0,
      totalCostUsd: over.cost ?? 0,
      costIsEstimate: false,
      lastActivityAt: "2026-09-20T04:10:35.093Z",
    },
  };
}

function stub(status: TemplateStatus, over: Parameters<typeof detail>[1] = {}, extra: Record<string, unknown> = {}) {
  stubFetch({
    ...healthStubs,
    "/api/clients": { body: tree },
    [`/api/templates/${TPL_ID}`]: { body: detail(status, over) },
    ...extra,
  });
}

/** 步骤条里某一步的按钮 */
function stepButton(label: string): HTMLElement {
  const bar = screen.getByRole("navigation", { name: "流水线步骤" });
  return within(bar).getByRole("button", { name: new RegExp(`^${label}`) });
}

beforeEach(() => {
  stub("importing");
});

describe("模板页头", () => {
  it("面包屑给客户名，标题给模板名", async () => {
    renderApp(BASE);
    expect(await screen.findByRole("heading", { name: "足球榜单" })).toBeInTheDocument();
    expect(screen.getByText("老王工作室", { selector: "span" })).toBeInTheDocument();
  });

  it("模板累计花费一律带「估」（REQ-009 MUST）", async () => {
    stub("approved", { cost: 12.5, outputs: 2 });
    renderApp(BASE);
    expect(await screen.findByText("$12.50")).toBeInTheDocument();
    expect(screen.getByText("模板累计")).toBeInTheDocument();
    expect(screen.getByText("估")).toBeInTheDocument();
  });

  it("点标题就地改名，改完发 PATCH", async () => {
    const patch = vi.fn();
    stub(
      "importing",
      {},
      {
        [`PATCH /api/templates/${TPL_ID}`]: (init?: RequestInit) => {
          patch(init?.body);
          return { body: detail("importing") };
        },
      },
    );
    renderApp(BASE);

    // 可点的是标题里那个按钮，h1 只负责语义
    await userEvent.click(await screen.findByRole("button", { name: "足球榜单" }));
    const input = await screen.findByLabelText("模板名");
    await userEvent.clear(input);
    await userEvent.type(input, "新名字{Enter}");

    await waitFor(() => expect(patch).toHaveBeenCalledWith(JSON.stringify({ name: "新名字" })));
  });

  it("改名撞重名时红字贴在输入框下（AC-003）", async () => {
    stub(
      "importing",
      {},
      {
        [`PATCH /api/templates/${TPL_ID}`]: {
          status: 409,
          body: { error: { code: "NAME_TAKEN", message: "名称已存在" } },
        },
      },
    );
    renderApp(BASE);

    await userEvent.click(await screen.findByRole("button", { name: "足球榜单" }));
    await userEvent.type(await screen.findByLabelText("模板名"), "{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("名称已存在");
  });
});

describe("步骤条（CMP-001）", () => {
  it("五步齐全且按顺序", async () => {
    renderApp(BASE);
    const bar = await screen.findByRole("navigation", { name: "流水线步骤" });
    const names = within(bar)
      .getAllByRole("button")
      .map((b) => b.textContent?.replace(/[^\u4e00-\u9fa5]/g, "").slice(0, 2));
    expect(names).toEqual(["参考", "复刻", "验货", "变体", "成片"]);
  });

  it("未解锁的步骤不可点，且读得出「未解锁」", async () => {
    renderApp(BASE);
    await screen.findByRole("heading", { name: "足球榜单" });
    expect(stepButton("变体")).toHaveAttribute("aria-disabled", "true");
    expect(stepButton("变体")).toHaveTextContent("未解锁");
    // AC-012：④ 变体 / ⑤ 成片 说清楚为什么锁着
    for (const name of ["变体", "成片"]) {
      expect(stepButton(name)).toHaveAttribute("title", "先通过验货");
      expect(stepButton(name)).toHaveTextContent("先通过验货");
    }
  });

  it("AC-012：未验货时点 ④变体，不跳过去，页面上说「先通过验货」", async () => {
    stub("awaiting_review");
    renderApp(`${BASE}/clone`);
    await screen.findByRole("heading", { name: "足球榜单" });
    await userEvent.click(stepButton("变体"));
    expect(await screen.findByText("「变体」还没解锁：先通过验货")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "④ 变体 工作区" })).toBeNull();
  });

  it("验货通过后 ④变体解锁并可点进去（SCOPE-004）", async () => {
    stub("approved");
    renderApp(`${BASE}/review`);
    await screen.findByRole("heading", { name: "足球榜单" });

    const variants = stepButton("变体");
    expect(variants).toBeEnabled();
    expect(variants).not.toHaveAttribute("aria-disabled");
    await userEvent.click(variants);

    expect(await screen.findByRole("region", { name: "④ 变体 工作区" })).toBeInTheDocument();
  });

  it("当前步骤标了 aria-current，其余没有", async () => {
    stub("approved");
    renderApp(`${BASE}/review`);
    await screen.findByRole("heading", { name: "足球榜单" });
    expect(stepButton("验货")).toHaveAttribute("aria-current", "step");
    expect(stepButton("参考")).not.toHaveAttribute("aria-current");
  });

  /**
   * 数据没到时这份步骤表是按缺省值猜的：一个已验货的模板会先被画成
   * 「①进行中 + 后面四个 ·」。这一帧的信息是错的，手快点下去会跳到一个
   * 马上要被重定向走的步骤，所以整体先不可点。
   */
  it("模板数据没回来前步骤条整体不可点", async () => {
    stub("approved", { outputs: 3 });
    renderApp(BASE);

    const bar = await screen.findByRole("navigation", { name: "流水线步骤" });
    expect(bar).toHaveAttribute("aria-busy", "true");
    expect(
      within(bar)
        .getAllByRole("button")
        .every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);

    // 数据到了之后恢复可点
    await screen.findByRole("heading", { name: "足球榜单" });
    expect(screen.getByRole("navigation", { name: "流水线步骤" })).not.toHaveAttribute("aria-busy");
    expect(stepButton("变体")).toBeEnabled();
  });

  it("待验货时 ③ 读作「需处理」——CMP-001 的琥珀点要能被读出来", async () => {
    stub("awaiting_review");
    renderApp(BASE);
    await screen.findByRole("heading", { name: "足球榜单" });
    expect(stepButton("验货")).toHaveTextContent("需处理");
  });
});

describe("步骤路由与刷新保持", () => {
  it("没带步骤时按当前状态送到该去的那一步", async () => {
    stub("awaiting_review");
    renderApp(BASE);
    // 待验货 → 直接停在 ③，不是从 ① 开始让人自己找
    expect(await screen.findByRole("region", { name: "③ 验货 工作区" })).toBeInTheDocument();
  });

  it("地址里带了哪一步就停在哪一步——刷新保持靠的就是这个", async () => {
    stub("approved", { outputs: 3 });
    renderApp(`${BASE}/clone`);

    // 必须先等数据到：第一帧 detail.data 还是 undefined，重定向被「加载中」守卫
    // 挡住，工作区已经按 URL 渲出来了。不等这一行，断言全都落在加载帧上，
    // 把「数据到了之后会不会被弹走」这件唯一要验的事整个绕过去——
    // 实测把重定向改成无视 URL，这条用例照样绿。
    await screen.findByRole("heading", { name: "足球榜单" });

    expect(screen.getByRole("region", { name: "② 复刻 工作区" })).toBeInTheDocument();
    expect(stepButton("复刻")).toHaveAttribute("aria-current", "step");
  });

  it("直接敲一个还没解锁的步骤会被送回该去的那一步，而不是给空白页", async () => {
    stub("cloning");
    renderApp(`${BASE}/variants`);
    expect(await screen.findByRole("region", { name: "② 复刻 工作区" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "④ 变体 工作区" })).not.toBeInTheDocument();
  });

  it("地址里塞一个根本不存在的步骤也照样被送回去", async () => {
    stub("cloning");
    renderApp(`${BASE}/根本不是步骤`);
    expect(await screen.findByRole("region", { name: "② 复刻 工作区" })).toBeInTheDocument();
  });

  it("模板不存在时说清楚，外壳还在", async () => {
    stubFetch({
      ...healthStubs,
      "/api/clients": { body: tree },
      [`/api/templates/${TPL_ID}`]: {
        status: 404,
        body: { error: { code: "TEMPLATE_NOT_FOUND", message: "模板不存在" } },
      },
    });
    renderApp(BASE);
    expect(await screen.findByText("这个模板已经不存在了。")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "客户与模板" })).toBeInTheDocument();
  });
});
