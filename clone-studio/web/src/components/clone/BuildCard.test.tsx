import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BuildCard } from "./BuildCard.js";
import type { BuildView } from "../../lib/build.js";
import { renderWithProviders, stubFetch, type RouteStub } from "../../test/harness.js";

/** CMP-007 出片进度 + 失败卡 + 完成卡：阶段文字、帧进度、取消（二次确认）、失败原文与可用内存、重试出片、花费标「估」 */

const PID = "prod-1";

function build(over: Partial<BuildView> = {}): BuildView {
  return {
    id: "b1",
    productionId: PID,
    status: "running",
    hypitBuildId: null,
    estimateUsd: 0.92,
    receiptId: null,
    receiptUrl: null,
    errorCode: null,
    errorMessage: null,
    outputPath: null,
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    endedAt: null,
    createdAt: "",
    context: null,
    activity: null,
    progress: {
      stage: "working",
      phase: "rendering frames",
      stepsDone: 1,
      stepsTotal: 3,
      unitsDone: 476,
      unitsTotal: 900,
      elapsed: "4m 41s",
      raw: "· Working · 1/3 steps complete · 1 rendering frames · 476/900 frames · 4m 41s",
    },
    ...over,
  };
}

function backend(current: () => RouteStub) {
  const calls = { cancel: 0, retry: 0 };
  stubFetch({
    [`/api/productions/${PID}/build`]: current,
    [`POST /api/productions/${PID}/build/cancel`]: () => {
      calls.cancel += 1;
      return {
        body: {
          build: build({ status: "cancelled", errorCode: "CANCELLED", errorMessage: "已取消出片", progress: null }),
        },
      };
    },
    [`POST /api/productions/${PID}/build/retry`]: () => {
      calls.retry += 1;
      return { body: { queued: true } };
    },
  });
  return calls;
}

const mount = () => renderWithProviders(<BuildCard productionId={PID} />);

describe("渲染中", () => {
  it("阶段「渲染」+ 帧进度 + 已用时长 + 进度条宽度；「取消」走二次确认后调接口", async () => {
    const calls = backend(() => ({ body: { build: build() } }));
    mount();
    const card = await screen.findByRole("region", { name: "出片" });
    expect(within(card).getByText("渲染中")).toBeTruthy();
    expect(within(card).getByText("渲染")).toBeTruthy();
    expect(within(card).getByText("476/900 帧")).toBeTruthy();
    expect(within(card).getByText(/^1:0\d$/)).toBeTruthy();
    const bar = within(card).getByText("渲染").closest("div")?.nextElementSibling as HTMLElement;
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("53%");

    await userEvent.click(within(card).getByRole("button", { name: "取消" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "取消出片" }));
    await waitFor(() => expect(calls.cancel).toBe(1));
  });

  it("还没有进度行、但 activity 帧说 Runtime 在渲染：阶段按 activity 给「渲染」", async () => {
    backend(() => ({
      body: {
        build: build({ progress: null, activity: { phases: { "rendering frames": 1 }, requests: null } }),
      },
    }));
    mount();
    const card = await screen.findByRole("region", { name: "出片" });
    expect(within(card).getByText("渲染")).toBeTruthy();
  });

  it("还没有进度行：阶段「提交」，进度条不定长", async () => {
    backend(() => ({ body: { build: build({ progress: null }) } }));
    mount();
    const card = await screen.findByRole("region", { name: "出片" });
    expect(within(card).getByText("提交")).toBeTruthy();
    const bar = within(card).getByText("提交").closest("div")?.nextElementSibling as HTMLElement;
    expect((bar.firstElementChild as HTMLElement).className).toContain("animate-pulse");
  });
});

describe("失败与完成", () => {
  it("失败：错误码、failure 原文完整、可用内存、最后进度，「重试出片」调接口", async () => {
    const failure = "Command need:… failed render-visual: Rendered visual frame rate differs from its document\n第二行";
    const calls = backend(() => ({
      body: {
        build: build({
          status: "failed",
          errorCode: "BUILD_FAILED",
          errorMessage: failure,
          progress: null,
          context: {
            freeMemBytes: 4.7 * 1024 ** 3,
            totalMemBytes: 32 * 1024 ** 3,
            lastProgress: "· Saving Result · 8m 21s",
          },
        }),
      },
    }));
    mount();
    const card = await screen.findByRole("region", { name: "出片" });
    expect(within(card).getByText("出片失败")).toBeTruthy();
    // Design-Brief §4 错误态：红边 + 下方原文
    expect(card.className).toContain("border-danger");
    expect(within(card).getByText("BUILD_FAILED")).toBeTruthy();
    // 原文在 <pre> 里、带换行：getByText 会把空白折叠，按节点原文比
    expect(within(card).getByText((_, el) => el?.tagName === "PRE" && el.textContent === failure)).toBeTruthy();
    expect(
      within(card).getByText(/失败时可用内存 4\.7 GB \/ 32\.0 GB · 最后进度：· Saving Result · 8m 21s/),
    ).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "重试出片" }));
    await waitFor(() => expect(calls.retry).toBe(1));
  });

  it("完成：文件名、估价标「估」、hypit build id、receipt 链接", async () => {
    backend(() => ({
      body: {
        build: build({
          status: "done",
          progress: null,
          hypitBuildId: "bld_20260923T090202973Z_FFE1F434A7",
          outputPath: "X:\\data\\clients\\c\\templates\\t\\output\\replica-v1-abcd1234.mp4",
          receiptUrl: "https://tokendance.space/receipts/1",
        }),
      },
    }));
    mount();
    const card = await screen.findByRole("region", { name: "出片" });
    expect(within(card).getByText("已出片")).toBeTruthy();
    expect(within(card).getByText("replica-v1-abcd1234.mp4")).toBeTruthy();
    expect(within(card).getByText("$0.92")).toBeTruthy();
    expect(within(card).getByText("估")).toBeTruthy();
    expect(within(card).getByText("bld_20260923T090202973Z_FFE1F434A7")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "去 Provider 侧查看 receipt" }).getAttribute("href")).toBe(
      "https://tokendance.space/receipts/1",
    );
  });

  it("receipt 链接只认 http(s)：别的 scheme 不渲染成链接", async () => {
    backend(() => ({
      body: { build: build({ status: "done", progress: null, receiptUrl: "ftp://evil.example/receipt" }) },
    }));
    mount();
    const card = await screen.findByRole("region", { name: "出片" });
    expect(within(card).queryByRole("link")).toBeNull();
  });

  it("没出过片（404）：不渲染", async () => {
    backend(() => ({ status: 404, body: { error: { code: "NO_BUILD", message: "这条还没有出过片" } } }));
    mount();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("region", { name: "出片" })).toBeNull();
  });
});
