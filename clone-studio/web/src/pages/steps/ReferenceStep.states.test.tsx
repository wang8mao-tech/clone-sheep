import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/harness.js";
import type { TemplateStatus } from "../../lib/archive.js";
import {
  BASE,
  detail,
  EVIDENCE,
  evidence,
  IDLE,
  PENDING,
  stepButton,
  stub,
  TPL_ID,
} from "../../test/reference-fixtures.js";

describe("① 参考 · 失败与重试", () => {
  const brokenLink = evidence("failed", [
    [
      "fetch",
      "failed",
      {
        durationMs: 3_000,
        errorCode: "CLI_ERROR",
        errorMessage: "yt-dlp could not fetch …404",
        errorRaw: "stderr 全文",
      },
    ],
    ...PENDING.slice(1),
  ]);

  it("AC-006：下载步骤标红并显示 hypit 原文，可改为上传文件重新提交", async () => {
    const user = userEvent.setup();
    stub("failed", brokenLink);
    renderApp(`${BASE}/reference`);
    const failed = await screen.findByRole("listitem", { name: /^下载：失败/ });
    const alert = within(failed).getByRole("alert");
    expect(within(alert).getByText("CLI_ERROR")).toBeInTheDocument();
    expect(alert).toHaveTextContent("yt-dlp could not fetch …404");
    expect(within(failed).getByText("stderr 全文")).toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: "重试此步" })).toBeEnabled();
    // 表单没锁，能切到上传
    await user.click(screen.getByRole("radio", { name: "上传文件" }));
    expect(screen.getByLabelText("选择视频文件")).toBeEnabled();
    expect(screen.getByRole("button", { name: "开始复刻" })).toBeEnabled();
  });

  it("点「重试此步」调重试接口并换上新快照；重跑期间 ①参考 进行中，②复刻 不标失败", async () => {
    const user = userEvent.setup();
    const running = evidence("running", [["fetch", "running"], ...PENDING.slice(1)]);
    let retriedYet = false;
    const retried = vi.fn(() => {
      retriedYet = true;
      return { body: running };
    });
    stub("failed", brokenLink, {
      [`POST ${EVIDENCE}/fetch/retry`]: retried,
      [EVIDENCE]: () => ({ body: retriedYet ? running : brokenLink }),
      // 与真实后端一致：重试后模板回到 importing、证据状态 running
      [`/api/templates/${TPL_ID}`]: () => ({
        body: retriedYet
          ? detail("importing", { evidenceStatus: "running" })
          : detail("failed", { evidenceStatus: "failed" }),
      }),
    });
    renderApp(`${BASE}/reference`);
    await user.click(await screen.findByRole("button", { name: "重试此步" }));
    expect(retried).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("listitem", { name: /^下载：进行中/ })).toBeInTheDocument();
    await waitFor(() => expect(stepButton("参考")).toHaveTextContent("进行中"));
    expect(stepButton("复刻")).not.toHaveTextContent("失败");
    expect(stepButton("复刻")).toBeDisabled();
  });

  it("AC-005：超 180 秒停在探测并给出原话", async () => {
    stub(
      "failed",
      evidence("failed", [
        ["fetch", "done", { durationMs: 1_000 }],
        ["probe", "failed", { errorCode: "DURATION_TOO_LONG", errorMessage: "时长超过 180 秒（实际 200.0 秒）。" }],
        ["transcribe", "pending"],
        ["tiles", "pending"],
      ]),
    );
    renderApp(`${BASE}/reference`);
    const probe = await screen.findByRole("listitem", { name: /^探测：失败/ });
    expect(within(probe).getByRole("alert")).toHaveTextContent("时长超过 180 秒");
    expect(screen.getByRole("listitem", { name: /^转写.*：等待/ })).toBeInTheDocument();
    // 源视频已落盘，但失败仍记在 ①参考 头上，②复刻 不解锁（审查 HIGH）
    expect(stepButton("参考")).toHaveTextContent("失败");
    expect(stepButton("复刻")).toBeDisabled();
  });

  it("下载之后的步骤失败：进模板页落在 ①参考，而不是被送去 ②复刻", async () => {
    stub(
      "failed",
      evidence("failed", [
        ["fetch", "done"],
        ["probe", "done"],
        ["transcribe", "done"],
        ["tiles", "failed", { errorCode: "CLI_ERROR", errorMessage: "VipsJpeg: unable to write to target" }],
      ]),
    );
    renderApp(BASE);
    expect(await screen.findByRole("listitem", { name: /^抽帧拼图：失败/ })).toBeInTheDocument();
    expect(stepButton("参考")).toHaveAttribute("aria-current", "step");
    expect(screen.queryByRole("region", { name: "② 复刻 工作区" })).not.toBeInTheDocument();
  });

  it("链接下载失败：给出改为上传的提示，一点就切到上传", async () => {
    const user = userEvent.setup();
    stub("failed", brokenLink, {}, { sourceKind: "url", sourceUrl: "https://example.invalid/nope.mp4" });
    renderApp(`${BASE}/reference`);
    const failed = await screen.findByRole("listitem", { name: /^下载：失败/ });
    expect(within(failed).getByText("链接下载不下来的话，可以改为上传视频文件后重新提交。")).toBeInTheDocument();
    await user.click(within(failed).getByRole("button", { name: "改为上传文件" }));
    expect(screen.getByRole("radio", { name: "上传文件" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("选择视频文件")).toBeInTheDocument();
  });

  it("转写前在拉起本地服务：清单显示后端挂的附注，而不是笼统的「转写中」", async () => {
    stub(
      "importing",
      evidence("running", [
        ["fetch", "done"],
        ["probe", "done"],
        ["transcribe", "running", { detail: { note: "正在启动 WhisperX 服务" } }],
        ["tiles", "pending"],
      ]),
    );
    renderApp(`${BASE}/reference`);
    const t = await screen.findByRole("listitem", { name: /^转写.*：进行中/ });
    expect(within(t).getByText("正在启动 WhisperX 服务")).toBeInTheDocument();
  });

  it("超时单独标出，同样可重试", async () => {
    stub(
      "failed",
      evidence("failed", [
        ["fetch", "done"],
        ["probe", "done"],
        ["transcribe", "timeout", { errorCode: "TIMEOUT", errorMessage: "超过 600s 未返回" }],
        ["tiles", "pending"],
      ]),
    );
    renderApp(`${BASE}/reference`);
    const t = await screen.findByRole("listitem", { name: /^转写.*：超时/ });
    expect(within(t).getByText("超过 10 分钟")).toBeInTheDocument();
    expect(within(t).getByRole("button", { name: "重试此步" })).toBeEnabled();
  });

  it("读不到状态时给错误态与重试，不是一直转圈", async () => {
    stub("importing", IDLE, { [EVIDENCE]: { status: 500, body: { error: { message: "库坏了" } } } });
    renderApp(`${BASE}/reference`);
    expect(await screen.findByText("读不到参考视频的准备状态。")).toBeInTheDocument();
  });
});

describe("① 参考 · SSE 驱动", () => {
  /** 记下每个 EventSource，用例里手动往里推事件 */
  const sources: EventTarget[] = [];

  beforeEach(() => {
    sources.length = 0;
    class TrackingEventSource extends EventTarget {
      onmessage: ((e: MessageEvent) => void) | null = null;
      constructor(readonly url: string) {
        super();
        sources.push(this);
      }
      close(): void {}
    }
    vi.stubGlobal("EventSource", TrackingEventSource);
  });

  it("收到 evidence 事件重拉快照；四步全完成时自动进 ②复刻", async () => {
    let state = evidence("running", [
      ["fetch", "done"],
      ["probe", "done"],
      ["transcribe", "done"],
      ["tiles", "running"],
    ]);
    let tplStatus: TemplateStatus = "importing";
    stub("importing", state, {
      [EVIDENCE]: () => ({ body: state }),
      [`/api/templates/${TPL_ID}`]: () => ({
        body: detail(tplStatus, { hasSource: true, evidenceStatus: state.status }),
      }),
    });
    renderApp(`${BASE}/reference`);
    expect(await screen.findByRole("listitem", { name: /^抽帧拼图：进行中/ })).toBeInTheDocument();

    state = evidence("done", [
      ["fetch", "done"],
      ["probe", "done"],
      ["transcribe", "done"],
      ["tiles", "done"],
    ]);
    tplStatus = "cloning";
    const frame = JSON.stringify({ topic: `template:${TPL_ID}`, data: { templateId: TPL_ID, step: "tiles" } });
    act(() => {
      for (const s of sources) s.dispatchEvent(new MessageEvent("evidence", { data: frame }));
    });

    expect(await screen.findByRole("region", { name: "② 复刻 工作区" })).toBeInTheDocument();
  });

  it("证据先完成、模板状态还没跟上：先不跳，等模板进入 cloning 再跳（审查指出的竞态）", async () => {
    let state = evidence("running", [
      ["fetch", "done"],
      ["probe", "done"],
      ["transcribe", "done"],
      ["tiles", "running"],
    ]);
    let tplStatus: TemplateStatus = "importing";
    stub("importing", state, {
      [EVIDENCE]: () => ({ body: state }),
      [`/api/templates/${TPL_ID}`]: () => ({
        body: detail(tplStatus, { hasSource: true, evidenceStatus: state.status }),
      }),
    });
    renderApp(`${BASE}/reference`);
    expect(await screen.findByRole("listitem", { name: /^抽帧拼图：进行中/ })).toBeInTheDocument();

    const push = (): void => {
      const frame = JSON.stringify({ topic: `template:${TPL_ID}`, data: { templateId: TPL_ID } });
      act(() => {
        for (const s of sources) s.dispatchEvent(new MessageEvent("evidence", { data: frame }));
      });
    };
    // 证据完成了，但模板详情还停在 importing（它那一路重拉慢了）
    state = evidence("done", [
      ["fetch", "done"],
      ["probe", "done"],
      ["transcribe", "done"],
      ["tiles", "done"],
    ]);
    push();
    expect(await screen.findByRole("listitem", { name: /^抽帧拼图：完成/ })).toBeInTheDocument();
    // 等跳转副作用和布局的重定向都落定再断言：立刻断言会赶在 navigate 之前，测不出竞态
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(screen.queryByRole("region", { name: "② 复刻 工作区" })).not.toBeInTheDocument();
    expect(screen.getByRole("form", { name: "导入参考视频" })).toBeInTheDocument();

    // 模板跟上了：这时才跳，而且没有因为上一次没跳成就再也不跳
    tplStatus = "cloning";
    push();
    expect(await screen.findByRole("region", { name: "② 复刻 工作区" })).toBeInTheDocument();
  });

  it("已经完成的模板回来看 ①参考 不会被弹走", async () => {
    stub(
      "cloning",
      evidence("done", [
        ["fetch", "done"],
        ["probe", "done"],
        ["transcribe", "done"],
        ["tiles", "done"],
      ]),
    );
    renderApp(`${BASE}/reference`);
    expect(await screen.findByRole("listitem", { name: /^抽帧拼图：完成/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "② 复刻 工作区" })).not.toBeInTheDocument();
  });
});
