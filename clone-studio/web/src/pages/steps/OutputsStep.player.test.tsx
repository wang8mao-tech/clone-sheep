import { beforeEach, describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { TPL } from "../../test/agent-drawer-kit.js";
import {
  costs,
  installOutputSources,
  mountOutputs,
  output,
  outputsBackend,
  templateSource,
} from "../../test/outputs-kit.js";
import { buildView } from "../../test/variants-kit.js";

/** ⑤ 播放弹层（SCREEN-008）：播放与下载、花费明细 CMP-008（AC-024）、失败看原文与重试出片、删除 */

beforeEach(() => {
  installOutputSources();
});

async function openCard(name: string) {
  const mounted = await mountOutputs();
  await mounted.user.click(await screen.findByRole("button", { name }));
  const dialog = await screen.findByRole("dialog", { name: /^成片：/ });
  return { ...mounted, dialog };
}

describe("播放与下载（AC-020）", () => {
  it("完成的：页内播放器指向成片，下载链接带 download=1", async () => {
    outputsBackend([output(1)]);
    const { dialog } = await openCard("播放 成片 1");
    const video = within(dialog).getByLabelText("播放 成片 1");
    expect(video.tagName).toBe("VIDEO");
    expect(video.getAttribute("src")).toBe("/api/productions/p1/video");
    expect(within(dialog).getByRole("link", { name: "下载" })).toHaveAttribute(
      "href",
      "/api/productions/p1/video?download=1",
    );
  });

  it("文件不在了：不放播放器、不给下载，写明原因", async () => {
    outputsBackend([output(1, { downloadable: false })]);
    const { dialog } = await openCard("播放 成片 1");
    expect(within(dialog).getByText("成片文件不在了，没法播放。")).toBeInTheDocument();
    expect(within(dialog).queryByRole("link", { name: "下载" })).toBeNull();
  });
});

describe("花费明细 CMP-008（AC-024）", () => {
  it("Agent 任务与出片两笔分列，都标「估」，给合计", async () => {
    outputsBackend([output(1)]);
    const { dialog } = await openCard("播放 成片 1");
    const agent = await within(dialog).findByRole("table", { name: "Agent 任务花费" });
    expect(agent).toHaveTextContent("claude-sonnet-5");
    expect(agent).toHaveTextContent("3:40");
    expect(agent).toHaveTextContent("$0.80估");
    const builds = within(dialog).getByRole("table", { name: "出片花费" });
    expect(builds).toHaveTextContent("本机渲染");
    expect(builds).toHaveTextContent("$0.00估");
    expect(builds).toHaveTextContent("bld_abc");
    expect(within(dialog).getByRole("region", { name: "花费明细" })).toHaveTextContent("合计$0.80估");
  });

  it("复刻片的共用会话标「共用」；有 receipt 链接就给出去；没有任何花费写明", async () => {
    outputsBackend([output(1, { kind: "replica" }), output(2)], {
      "/api/productions/:id/costs": (_req, url) =>
        url?.includes("/p1/")
          ? {
              body: costs({
                agent: [{ ...costs().agent[0]!, shared: true }],
                builds: [{ ...costs().builds[0]!, receiptUrl: "https://td.example/r/1", hypitBuildId: "bld_r" }],
                totalUsd: 0,
              }),
            }
          : { body: costs({ productionId: "p2", agent: [], builds: [], totalUsd: 0, totalIsEstimate: false }) },
    });
    const { dialog, user } = await openCard("播放 成片 1");
    expect(await within(dialog).findByText("共用")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "bld_r" })).toHaveAttribute("href", "https://td.example/r/1");
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "播放 成片 2" }));
    const second = await screen.findByRole("dialog", { name: "成片：成片 2" });
    expect(await within(second).findByText("这条没有 Agent 任务。")).toBeInTheDocument();
    expect(within(second).getByText("还没有出过片。")).toBeInTheDocument();
  });

  it("Agent 花费不是估算（将来 API key 档案）也照样标「估」（REQ-009 MUST，9.2 审查 S1-6）", async () => {
    outputsBackend([output(1)], {
      "/api/productions/:id/costs": { body: costs({ agent: [{ ...costs().agent[0]!, isEstimate: false }] }) },
    });
    const { dialog } = await openCard("播放 成片 1");
    expect(await within(dialog).findByRole("table", { name: "Agent 任务花费" })).toHaveTextContent("$0.80估");
  });

  it("Agent 行写档案名与模型；兼容端点没填单价的花费写「未知」不写 $0（REQ-010，Task 10.4）", async () => {
    outputsBackend([output(1)], {
      "/api/productions/:id/costs": {
        body: costs({
          agent: [
            { ...costs().agent[0]!, profileName: "DeepSeek", model: "deepseek-flash", costBasis: "none", costUsd: 0 },
          ],
        }),
      },
    });
    const { dialog } = await openCard("播放 成片 1");
    const table = await within(dialog).findByRole("table", { name: "Agent 任务花费" });
    expect(table).toHaveTextContent("DeepSeek");
    expect(table).toHaveTextContent("deepseek-flash");
    expect(table).toHaveTextContent("未知");
    expect(table).not.toHaveTextContent("$0.00");
    // 合计下面写明不含算不出的那部分（10.4 审查 S1-M2）
    expect(within(dialog).getByText("不含没填单价、算不出的 Agent 花费")).toBeInTheDocument();
  });

  it("花费读不到：写明并给重试", async () => {
    outputsBackend([output(1)], {
      "/api/productions/:id/costs": { status: 500, body: { error: { code: "INTERNAL", message: "炸了" } } },
    });
    const { dialog } = await openCard("播放 成片 1");
    expect(await within(dialog).findByText("读不到花费明细")).toBeInTheDocument();
  });
});

describe("失败的成片", () => {
  it("点开看出片错误原文，给「重试出片」", async () => {
    const db = outputsBackend([
      output(1, {
        status: "failed",
        retryable: true,
        stop: { step: "build", text: "出片失败 · BUILD_FAILED\n渲染炸了" },
        downloadable: false,
        build: buildView({ productionId: "p1", status: "failed", errorCode: "BUILD_FAILED", errorMessage: "渲染炸了" }),
      }),
    ]);
    const { dialog, user } = await openCard("查看 成片 1");
    expect(within(dialog).getByText(/BUILD_FAILED\s+渲染炸了/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "重试出片" }));
    await waitFor(() => expect(db.retries).toEqual(["p1"]));
  });

  it("重试被拒：写明原因", async () => {
    outputsBackend(
      [
        output(1, {
          status: "failed",
          retryable: true,
          downloadable: false,
          build: buildView({ productionId: "p1", status: "failed" }),
        }),
      ],
      {
        "POST /api/productions/:id/build/retry": {
          status: 409,
          body: { error: { code: "NOT_RETRYABLE", message: "这条不能重试" } },
        },
      },
    );
    const { dialog, user } = await openCard("查看 成片 1");
    await user.click(within(dialog).getByRole("button", { name: "重试出片" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("没能重试：这条不能重试");
  });
});

describe("熔断的变体（9.2 第二轮审查 S1-B）", () => {
  it("不给重试出片、不把旧的出片错误当现在的原因，指去 ④", async () => {
    outputsBackend([
      output(1, {
        status: "failed",
        productionStatus: "tripped",
        stop: { step: "agent", text: "Agent 写稿停下", reason: "budget：花费达到上限" },
        downloadable: false,
        build: buildView({
          productionId: "p1",
          status: "failed",
          errorCode: "BUILD_FAILED",
          errorMessage: "上一稿渲染炸了",
        }),
      }),
    ]);
    const { dialog } = await openCard("查看 成片 1");
    expect(within(dialog).queryByRole("button", { name: "重试出片" })).toBeNull();
    expect(within(dialog).queryByText(/上一稿渲染炸了/)).toBeNull();
    expect(within(dialog).getByText("停在 Agent 写稿这一段，去 ④ 变体队列继续或重跑。")).toBeInTheDocument();
  });
});

describe("④ 重跑之后 Agent 又失败（9.2 第三轮审查 S1-1）", () => {
  it("旧的出片失败还在台账里：不给重试出片、不把旧错误当原因，指去 ④", async () => {
    outputsBackend([
      output(1, {
        status: "failed",
        retryable: false,
        stop: { step: "agent", text: "Agent 写稿停下" },
        downloadable: false,
        build: buildView({
          productionId: "p1",
          status: "failed",
          errorCode: "BUILD_FAILED",
          errorMessage: "上上稿渲染炸了",
        }),
      }),
    ]);
    const { dialog } = await openCard("查看 成片 1");
    expect(within(dialog).queryByRole("button", { name: "重试出片" })).toBeNull();
    expect(within(dialog).queryByText(/上上稿渲染炸了/)).toBeNull();
    expect(within(dialog).getByText("停在 Agent 写稿这一段，去 ④ 变体队列继续或重跑。")).toBeInTheDocument();
  });
});

describe("估价没过（9.2 第四轮审查 S1-H1 / S1-M1）", () => {
  it("复刻片估价没过、没出过片：写明估价没过与原因，指去 ②，不提 ④ 与 Agent", async () => {
    outputsBackend([
      output(1, {
        kind: "replica",
        status: "failed",
        downloadable: false,
        build: null,
        stop: { step: "estimate", text: "估价没过，不出片\n有请求没有可用的 Provider" },
      }),
    ]);
    const { dialog } = await openCard("查看 成片 1");
    expect(within(dialog).getByText(/估价没过，不出片\s+有请求没有可用的 Provider/)).toBeInTheDocument();
    expect(within(dialog).getByText("去 ② 复刻页重新估价。")).toBeInTheDocument();
    expect(within(dialog).queryByText(/④/)).toBeNull();
    expect(within(dialog).queryByText(/Agent 写稿/)).toBeNull();
  });

  it("重试后重新估价没过：说估价，不说旧的出片错误；仍给重试出片", async () => {
    outputsBackend([
      output(1, {
        status: "failed",
        retryable: true,
        downloadable: false,
        build: buildView({
          productionId: "p1",
          status: "failed",
          errorCode: "BUILD_FAILED",
          errorMessage: "旧的渲染错误",
        }),
        stop: { step: "estimate", text: "估价没过，不出片\npreflight 没有通过" },
      }),
    ]);
    const { dialog } = await openCard("查看 成片 1");
    expect(within(dialog).getByText(/preflight 没有通过/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/旧的渲染错误/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "重试出片" })).toBeInTheDocument();
  });
});

describe("开着弹层时花费明细跟着更新（9.2 审查 S2-4）", () => {
  it("后端推 build：弹层里的花费明细重拉", async () => {
    let reads = 0;
    outputsBackend([output(1)], {
      "/api/productions/:id/costs": () => {
        reads += 1;
        return { body: costs() };
      },
    });
    const { dialog } = await openCard("播放 成片 1");
    await within(dialog).findByRole("table", { name: "Agent 任务花费" });
    const before = reads;
    act(() => templateSource()?.emit("build", `template:${TPL}`, {}));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });
});

describe("删除成片", () => {
  async function confirmDelete(user: Awaited<ReturnType<typeof openCard>>["user"], name: string) {
    const confirm = await screen.findByRole("dialog", { name: `删除成片「${name}」` });
    await user.type(within(confirm).getByLabelText(`输入「${name}」以确认`), name);
    await user.click(within(confirm).getByRole("button", { name: "删除成片" }));
    return confirm;
  }

  it("CMP-012：写明后果、输入名称才能删；删掉后弹层关上、网格里没了", async () => {
    const db = outputsBackend([output(1), output(2)]);
    const { dialog, user } = await openCard("播放 成片 1");
    await user.click(within(dialog).getByRole("button", { name: "删除成片" }));
    const confirm = await screen.findByRole("dialog", { name: "删除成片「成片 1」" });
    expect(confirm).toHaveTextContent("它的花费照旧计入模板与客户的累计");
    expect(within(confirm).getByRole("button", { name: "删除成片" })).toBeDisabled();
    expect(db.deletes).toEqual([]);
    await confirmDelete(user, "成片 1");
    await waitFor(() => expect(db.deletes).toEqual(["p1"]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "播放 成片 1" })).toBeNull());
    expect(screen.getByRole("button", { name: "播放 成片 2" })).toBeInTheDocument();
    // 接着打开另一条：不能一打开就弹它的删除确认（9.2 第二轮审查 S1-A）
    await user.click(screen.getByRole("button", { name: "播放 成片 2" }));
    await screen.findByRole("dialog", { name: "成片：成片 2" });
    expect(screen.queryByRole("dialog", { name: "删除成片「成片 2」" })).toBeNull();
  });

  it("失败的变体删了会一并作废：确认框里写明", async () => {
    outputsBackend([
      output(1, { status: "failed", downloadable: false, build: buildView({ productionId: "p1", status: "failed" }) }),
    ]);
    const { dialog, user } = await openCard("查看 成片 1");
    await user.click(within(dialog).getByRole("button", { name: "删除成片" }));
    const confirm = await screen.findByRole("dialog", { name: "删除成片「成片 1」" });
    expect(confirm).toHaveTextContent("这条变体会一并作废，之后不能再重试出片或重跑");
    expect(confirm).toHaveTextContent("这条成片从成片库里移除");
  });

  it("删除被拒（文件被占用）：原文写在确认框里，框不关、成片还在", async () => {
    outputsBackend([output(1)], {
      "DELETE /api/productions/:id/output": {
        status: 409,
        body: {
          error: { code: "OUTPUT_FILE_BUSY", message: "成片文件被占用或没有删除权限（比如播放器开着），处理之后再删" },
        },
      },
    });
    const { dialog, user } = await openCard("播放 成片 1");
    await user.click(within(dialog).getByRole("button", { name: "删除成片" }));
    const confirm = await confirmDelete(user, "成片 1");
    expect(await within(confirm).findByText(/没删成：成片文件被占用/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("播放 成片 1")).toBeInTheDocument();
  });

  it("确认框里点取消：只关确认框，播放弹层还开着", async () => {
    const db = outputsBackend([output(1)]);
    const { dialog, user } = await openCard("播放 成片 1");
    await user.click(within(dialog).getByRole("button", { name: "删除成片" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "删除成片「成片 1」" })).getByRole("button", { name: "取消" }),
    );
    expect(screen.getByRole("dialog", { name: "成片：成片 1" })).toHaveAttribute("open");
    expect(within(dialog).getByLabelText("播放 成片 1")).toBeInTheDocument();
    expect(db.deletes).toEqual([]);
  });

  it("服务端一定会拒的删除不给点并写明原因：流水线里的、失败的复刻片（9.2 审查 S1-5）", async () => {
    outputsBackend([
      output(1, { status: "pending", productionStatus: "queued", downloadable: false, build: null }),
      output(2, { kind: "replica", status: "failed", productionStatus: "failed", downloadable: false }),
    ]);
    const { dialog, user } = await openCard("查看 成片 1");
    expect(within(dialog).getByRole("button", { name: "删除成片" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "删除成片" })).toHaveAttribute(
      "title",
      "还在流水线里，等它结束或在 ④ 取消之后再删",
    );
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "查看 成片 2" }));
    const second = await screen.findByRole("dialog", { name: "成片：成片 2" });
    expect(within(second).getByRole("button", { name: "删除成片" })).toHaveAttribute(
      "title",
      "这是模板当前的复刻片，去 ② 重试出片或在 ③ 打回",
    );
  });
});
