import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { TPL } from "../../test/agent-drawer-kit.js";
import { installOutputSources, mountOutputs, output, outputsBackend, templateSource } from "../../test/outputs-kit.js";
import { buildView } from "../../test/variants-kit.js";

/** ⑤ 成片（SCREEN-008、REQ-007）：网格、状态、筛选、多选打包、改名、空态 / 加载 / 出错 */

beforeEach(() => {
  installOutputSources();
});

const grid = () => screen.findByRole("list", { name: "成片" });

describe("网格", () => {
  it("卡片：名称、时长、状态、花费带「估」；旧版复刻片写「已被 vN 取代」；渲染中写百分比", async () => {
    outputsBackend([
      output(1, { name: "国产手机拍照榜", durationS: 37 }),
      output(2, { kind: "replica", name: "复刻片 v1", supersededBy: 2 }),
      output(3, {
        status: "building",
        downloadable: false,
        coverUrl: null,
        durationS: null,
        build: buildView({
          productionId: "p3",
          status: "running",
          progress: {
            stage: "working",
            phase: null,
            stepsDone: null,
            stepsTotal: null,
            unitsDone: 108,
            unitsTotal: 270,
            elapsed: null,
            raw: "",
          },
        }),
      }),
    ]);
    await mountOutputs();
    const cards = within(await grid()).getAllByRole("listitem");
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent("国产手机拍照榜");
    expect(cards[0]).toHaveTextContent("0:37");
    expect(cards[1]).toHaveTextContent("0:09");
    expect(cards[0]).toHaveTextContent("完成");
    expect(cards[0]).toHaveTextContent("$0.80估");
    expect(cards[1]).toHaveTextContent("已被 v2 取代");
    expect(cards[2]).toHaveTextContent("渲染中 40%");
    expect(cards[2]).toHaveTextContent("—");
    expect(within(cards[2] as HTMLElement).getByText("9:16")).toBeInTheDocument();
  });

  it("封面图读不出来：换成占位，不留破图", async () => {
    outputsBackend([output(1)]);
    await mountOutputs();
    const img = (await grid()).querySelector("img") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    await waitFor(() => expect(screen.getByRole("list", { name: "成片" }).querySelector("img")).toBeNull());
    expect(screen.getByText("9:16")).toBeInTheDocument();
  });

  it("空态：一句话 + 去 ④ 的链接", async () => {
    outputsBackend([]);
    await mountOutputs();
    const link = await screen.findByRole("link", { name: "④ 变体" });
    expect(link.getAttribute("href")).toBe(`/clients/c1/templates/${TPL}/variants`);
    expect(screen.getByText(/还没有成片/)).toBeInTheDocument();
  });

  it("加载中：封面骨架", async () => {
    outputsBackend([]);
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/outputs")) return new Promise<Response>(() => undefined);
      return inner(input, init);
    });
    await mountOutputs();
    expect(screen.getByRole("list", { name: "读取成片" })).toHaveAttribute("aria-busy", "true");
  });

  it("读不到：写明并给重试", async () => {
    outputsBackend([], {
      [`/api/templates/${TPL}/outputs`]: { status: 500, body: { error: { code: "INTERNAL", message: "炸了" } } },
    });
    await mountOutputs();
    expect(await screen.findByText("读不到成片")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("推送", () => {
  it("后端推 outputs（改名、删除、封面取完）：网格重拉，新封面出现", async () => {
    const db = outputsBackend([output(1, { coverUrl: null, durationS: null })]);
    await mountOutputs();
    await grid();
    const before = db.reads;
    db.outputs = [output(1)];
    act(() => templateSource()?.emit("outputs", `template:${TPL}`, { meta: true }));
    await waitFor(() => expect(db.reads).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole("list", { name: "成片" }).querySelector("img")).not.toBeNull());
  });
});

describe("推送与重拉失败", () => {
  it.each(["build", "estimate", "variants"])("后端推 %s：网格重拉", async (event) => {
    const db = outputsBackend([output(1)]);
    await mountOutputs();
    await grid();
    const before = db.reads;
    act(() => templateSource()?.emit(event, `template:${TPL}`, {}));
    await waitFor(() => expect(db.reads).toBeGreaterThan(before));
  });

  it("之后某次重拉失败：网格和正在播放的弹层都留着，上面一行写明并给重试（9.2 审查 S2-1）", async () => {
    let fail = false;
    outputsBackend([output(1)], {
      [`/api/templates/${TPL}/outputs`]: () =>
        fail
          ? { status: 500, body: { error: { code: "INTERNAL", message: "炸了" } } }
          : { body: { outputs: [output(1)] } },
    });
    const { user } = await mountOutputs();
    await user.click(await screen.findByRole("button", { name: "播放 成片 1" }));
    const dialog = await screen.findByRole("dialog", { name: "成片：成片 1" });
    fail = true;
    act(() => templateSource()?.emit("build", `template:${TPL}`, {}));
    expect(await screen.findByText(/刷新成片失败/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "成片" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("播放 成片 1")).toBeInTheDocument();
  });

  it("熔断的变体：卡片写「已熔断」", async () => {
    outputsBackend([output(1, { status: "failed", productionStatus: "tripped", downloadable: false })]);
    await mountOutputs();
    expect(within(await grid()).getByText("已熔断")).toBeInTheDocument();
  });
});

describe("筛选", () => {
  it("全部 / 完成 / 进行中 / 失败，带条数；筛空了写明", async () => {
    outputsBackend([
      output(1),
      output(2, { status: "failed", downloadable: false }),
      output(3, { status: "pending", productionStatus: "awaiting_cost_confirm", downloadable: false, build: null }),
    ]);
    const { user } = await mountOutputs();
    await grid();
    const group = screen.getByRole("group", { name: "筛选" });
    expect(within(group).getByRole("button", { name: "全部 3" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(group).getByRole("button", { name: "失败 1" }));
    expect(within(await grid()).getAllByRole("listitem")).toHaveLength(1);
    await user.click(within(group).getByRole("button", { name: "进行中 1" }));
    expect(within(await grid()).getByText("待确认花费")).toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "完成 1" }));
    expect(within(await grid()).getByText("成片 1")).toBeInTheDocument();
  });

  it("筛选下没有成片：写明", async () => {
    outputsBackend([output(1)]);
    const { user } = await mountOutputs();
    await grid();
    await user.click(screen.getByRole("button", { name: "失败 0" }));
    expect(screen.getByText("这个筛选下没有成片。")).toBeInTheDocument();
  });
});

describe("多选打包（AC-021）", () => {
  it("只有完成的能勾；勾 2 条 → 已选 2，批量下载的地址带这两条；一条没勾时按钮不可点并说明", async () => {
    outputsBackend([output(1), output(2), output(3, { status: "failed", downloadable: false })]);
    const { user } = await mountOutputs();
    await grid();
    expect(screen.getByText("已选 0")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "批量下载 zip" })).toBeNull();
    expect(screen.getByRole("button", { name: "批量下载 zip" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "批量下载 zip" })).toHaveAttribute("title", "先勾选完成的成片");
    expect(screen.getByRole("checkbox", { name: "选择 成片 3" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "选择 成片 1" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 成片 2" }));
    expect(screen.getByText("已选 2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "批量下载 zip" })).toHaveAttribute(
      "href",
      `/api/templates/${TPL}/outputs/zip?ids=p1,p2`,
    );
    await user.click(screen.getByRole("checkbox", { name: "选择 成片 1" }));
    expect(screen.getByText("已选 1")).toBeInTheDocument();
  });
});

describe("勾了又被筛掉的", () => {
  it("照样打包，已选旁边说明有几条不在当前筛选", async () => {
    outputsBackend([output(1), output(2, { status: "failed", downloadable: false })]);
    const { user } = await mountOutputs();
    await grid();
    await user.click(screen.getByRole("checkbox", { name: "选择 成片 1" }));
    await user.click(screen.getByRole("button", { name: "失败 1" }));
    expect(screen.getByText("已选 1（1 条不在当前筛选）")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "批量下载 zip" })).toHaveAttribute(
      "href",
      `/api/templates/${TPL}/outputs/zip?ids=p1`,
    );
  });
});

describe("勾选之后变得不能下载", () => {
  it("刷新后那条不能下载了（比如文件被删）：自动不算进已选，打包地址里也没有它", async () => {
    const db = outputsBackend([output(1), output(2)]);
    const { user } = await mountOutputs();
    await grid();
    await user.click(screen.getByRole("checkbox", { name: "选择 成片 1" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 成片 2" }));
    expect(screen.getByText("已选 2")).toBeInTheDocument();
    db.outputs = [output(1, { downloadable: false }), output(2)];
    act(() => templateSource()?.emit("outputs", `template:${TPL}`, {}));
    await waitFor(() => expect(screen.getByText("已选 1")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "批量下载 zip" })).toHaveAttribute(
      "href",
      `/api/templates/${TPL}/outputs/zip?ids=p2`,
    );
  });
});

describe("改名", () => {
  it("点名称就地改，Enter 提交，存下后显示新名", async () => {
    const db = outputsBackend([output(1)]);
    const { user } = await mountOutputs();
    await user.click(await screen.findByRole("button", { name: "成片 1" }));
    const input = screen.getByRole("textbox", { name: "成片名称" });
    await user.clear(input);
    await user.type(input, "国产手机拍照榜{Enter}");
    await waitFor(() => expect(db.renames).toEqual([{ id: "p1", name: "国产手机拍照榜" }]));
    expect(await screen.findByRole("button", { name: "国产手机拍照榜" })).toBeInTheDocument();
  });

  it("后端拒绝（超长）：红字挂在输入框下，输入框留着", async () => {
    outputsBackend([output(1)], {
      "PATCH /api/productions/:id": {
        status: 400,
        body: { error: { code: "NAME_TOO_LONG", message: "成片名称最长 60 字" } },
      },
    });
    const { user } = await mountOutputs();
    await user.click(await screen.findByRole("button", { name: "成片 1" }));
    await user.type(screen.getByRole("textbox", { name: "成片名称" }), "x{Enter}");
    expect(await screen.findByText("成片名称最长 60 字")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "成片名称" })).toBeInTheDocument();
  });
});
