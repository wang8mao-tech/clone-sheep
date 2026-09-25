import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installEventSource, ControlledEventSource } from "../../test/fake-event-source.js";
import { healthStubs, renderApp, stubFetch } from "../../test/harness.js";
import type { CodexTry } from "../../lib/codex.js";

/** 设置页 Codex 订阅生图一行（REQ-011、AC-033、DASM-004） */

const settings = {
  perItemLimitUsd: 1.5,
  batchLimitUsd: 15,
  agentTimeoutMinutes: 45,
  agentBudgetUsd: 5,
  agentConcurrency: 2,
  renderConcurrency: 1,
  renderWorkers: 1,
  referenceMaxSeconds: 180,
  batchMaxItems: 50,
  codexProviderEnabled: false,
  updatedAt: "2026-09-20T04:00:00.000Z",
  paths: { dataRoot: "C:/data", hypitRoot: "C:/hypit", secrets: "C:/data/secrets.json" },
  credentials: { tokendance: null, hypihub: null, tokendanceVerifiedAt: null, hypihubVerifiedAt: null },
};

const check = (over: Record<string, unknown>) => ({
  id: "codex",
  name: "Codex CLI（订阅生图，可选）",
  blocking: false,
  ...over,
});
const READY = check({ status: "pass", detail: "codex-cli 0.153.4 · 已登录", fix: null, ready: true });
const LOGGED_OUT = check({ status: "warn", detail: "codex-cli 0.153.4 · 未登录", fix: "codex login", ready: false });

const tryView = (over: Partial<CodexTry>): CodexTry => ({
  id: "t1",
  status: "done",
  startedAt: "2026-09-25T10:00:00.000Z",
  endedAt: "2026-09-25T10:02:05.000Z",
  durationMs: 125_000,
  error: null,
  hasImage: true,
  cleanup: null,
  ...over,
});

function stubs(codex: unknown, extra: Record<string, unknown> = {}, enabled = false) {
  return {
    ...healthStubs,
    "/api/clients": { body: { clients: [] } },
    "/api/settings": { body: { ...settings, codexProviderEnabled: enabled } },
    "/api/health/checks": { body: { checks: codex ? [codex] : [], passed: 0, total: 1, blockingFailures: [] } },
    ...extra,
  };
}

async function row() {
  return screen.findByLabelText("Codex 订阅生图");
}

beforeEach(() => {
  installEventSource();
});

describe("AC-033：没登录", () => {
  it("开关不能开、写明原因与 codex login；试出一张图也不能点", async () => {
    stubFetch(stubs(LOGGED_OUT));
    renderApp("/settings");
    const r = await row();
    const toggle = within(r).getByRole("switch", { name: "启用 Codex 订阅生图" });
    await waitFor(() => expect(within(r).getByText("codex-cli 0.153.4 · 未登录")).toBeInTheDocument());
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("title", "Codex 没准备好：codex-cli 0.153.4 · 未登录");
    expect(within(r).getByText(/开关不能打开/)).toHaveTextContent("执行 codex login 后点「重新检测」");
    expect(within(r).getByRole("button", { name: "试出一张图" })).toBeDisabled();
  });

  it("体检还没回来：显示检测中，开关不可用且说明原因", async () => {
    stubFetch(
      stubs(null, { "/api/health/checks": { body: { checks: [], passed: 0, total: 0, blockingFailures: [] } } }),
    );
    renderApp("/settings");
    const r = await row();
    expect(within(r).getByText("检测中…")).toBeInTheDocument();
    expect(within(r).getByRole("switch")).toHaveAttribute("title", "体检还没出结果");
  });

  it("已经开着、后来没登录了：仍能关掉", async () => {
    const patch = vi.fn();
    stubFetch(
      stubs(
        LOGGED_OUT,
        {
          "PATCH /api/settings": (init?: RequestInit) => {
            patch(init?.body);
            return { body: { ...settings, codexProviderEnabled: false } };
          },
        },
        true,
      ),
    );
    renderApp("/settings");
    const toggle = within(await row()).getByRole("switch");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);
    await waitFor(() => expect(patch).toHaveBeenCalledWith(JSON.stringify({ codexProviderEnabled: false })));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });
});

describe("启用开关", () => {
  it("体检通过：点开发 PATCH，开关变成开", async () => {
    const patch = vi.fn();
    stubFetch(
      stubs(READY, {
        "PATCH /api/settings": (init?: RequestInit) => {
          patch(init?.body);
          return { body: { ...settings, codexProviderEnabled: true } };
        },
      }),
    );
    renderApp("/settings");
    const r = await row();
    await waitFor(() => expect(within(r).getByText("✓ codex-cli 0.153.4 · 已登录")).toBeInTheDocument());
    const toggle = within(r).getByRole("switch");
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);
    await waitFor(() => expect(patch).toHaveBeenCalledWith(JSON.stringify({ codexProviderEnabled: true })));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("服务端拒绝（体检在这期间变了）：报错原文，开关保持关", async () => {
    stubFetch(
      stubs(READY, {
        "PATCH /api/settings": {
          status: 409,
          body: { error: { code: "CODEX_NOT_READY", message: "Codex 没准备好：未登录（执行 codex login）" } },
        },
      }),
    );
    renderApp("/settings");
    const toggle = within(await row()).getByRole("switch");
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    expect(await screen.findByText("Codex 没准备好：未登录（执行 codex login）")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});

describe("试出一张图", () => {
  it("点了开始：进行中显示已用时间；SSE 的 codex-try 到了就重拉，出图后显示图与用时，不重跑整页体检", async () => {
    let state: CodexTry | null = null;
    let checksCalls = 0;
    const start = vi.fn();
    stubFetch(
      stubs(READY, {
        "/api/health/checks": () => {
          checksCalls += 1;
          return { body: { checks: [READY], passed: 1, total: 1, blockingFailures: [] } };
        },
        "/api/codex/try": () => ({ body: { try: state } }),
        "POST /api/codex/try": () => {
          start();
          state = tryView({
            status: "running",
            endedAt: null,
            durationMs: null,
            hasImage: false,
            startedAt: new Date().toISOString(),
          });
          return { status: 202, body: { try: state } };
        },
      }),
    );
    renderApp("/settings");
    const r = await row();
    const button = within(r).getByRole("button", { name: "试出一张图" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await within(r).findByText(/正在用 Codex 出一张测试图… 已用 0:0\d/)).toBeInTheDocument();
    expect(within(r).getByRole("button", { name: "试出一张图" })).toBeDisabled();

    const before = checksCalls;
    state = tryView({});
    act(() => {
      for (const s of ControlledEventSource.instances)
        if (!s.closed && s.topics.includes("global")) s.emit("codex-try", "global", { id: "t1", status: "done" });
    });
    const img = await within(r).findByRole("img", { name: "Codex 试出的测试图" });
    expect(img).toHaveAttribute("src", "/api/codex/try/t1/image");
    expect(within(r).getByText("出图成功，用时 2:05，花费 $0（订阅额度）")).toBeInTheDocument();
    expect(checksCalls).toBe(before);
  });

  it("失败：展开原文；上一次的结果打开页面就看得到", async () => {
    stubFetch(
      stubs(READY, {
        "/api/codex/try": {
          body: {
            try: tryView({
              status: "failed",
              hasImage: false,
              error: "Endpoint codex.local failed gpt-image-2: Codex 额度或限流：You've hit your usage limit.",
            }),
          },
        },
      }),
    );
    renderApp("/settings");
    const alert = await within(await row()).findByRole("alert", { name: "试出一张图失败" });
    expect(alert).toHaveTextContent("出图失败，用时 2:05：");
    expect(alert).toHaveTextContent("You've hit your usage limit.");
  });

  it("开始失败（另一张还在出）：报错原文", async () => {
    stubFetch(
      stubs(READY, {
        "/api/codex/try": { body: { try: null } },
        "POST /api/codex/try": { status: 409, body: { error: { code: "TRY_RUNNING", message: "上一张还在出" } } },
      }),
    );
    renderApp("/settings");
    const button = within(await row()).getByRole("button", { name: "试出一张图" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText("没能开始出图")).toBeInTheDocument();
    // 正文是服务端 message 的原文，不是整个 JSON 包（11.3 审查 L1）
    expect(screen.getByText("上一张还在出")).toBeInTheDocument();
    expect(screen.queryByText(/"error"/)).toBeNull();
  });
});

describe("11.3 审查后补", () => {
  const PKG_MISSING = check({
    status: "warn",
    detail: "codex-cli 0.153.4 · 已登录 · Provider 包没同步上：x（打开开关或试出一张图会重试同步）",
    fix: null,
    ready: true,
  });

  it("S1-M1：CLI 与登录都好、只是包没同步上（ready）：开关与试图都能点，提示写原因、不把中文当命令", async () => {
    stubFetch(stubs(PKG_MISSING));
    renderApp("/settings");
    const r = await row();
    await waitFor(() => expect(within(r).getByRole("switch")).toBeEnabled());
    expect(within(r).getByRole("button", { name: "试出一张图" })).toBeEnabled();
    const hint = within(r).getByText(/打开开关或试出一张图会重试同步/, { selector: "p" });
    expect(hint.querySelector("code")).toBeNull();
    expect(hint).not.toHaveTextContent("开关不能打开");
  });

  it("L3 / L4：开着但没准备好——写「已开着…出图会失败」；开关与按钮用 aria-describedby 指到这一行", async () => {
    stubFetch(stubs(LOGGED_OUT, {}, true));
    renderApp("/settings");
    const r = await row();
    const toggle = within(r).getByRole("switch");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    const hint = within(r).getByText(/已开着，但 Codex 没准备好，出图会失败/);
    expect(hint).toHaveTextContent("执行 codex login 后点「重新检测」");
    expect(toggle).toHaveAttribute("aria-describedby", hint.id);
    expect(within(r).getByRole("button", { name: "试出一张图" })).toHaveAttribute("aria-describedby", hint.id);
  });

  it("L2：Worker 没停掉的原文写出来", async () => {
    stubFetch(
      stubs(READY, {
        "/api/codex/try": { body: { try: tryView({ cleanup: "Worker 没停掉：worker stop timed out" }) } },
      }),
    );
    renderApp("/settings");
    expect(await within(await row()).findByText("Worker 没停掉：worker stop timed out")).toBeInTheDocument();
  });
});

describe("11.3 第二轮审查后补", () => {
  it("R2-L3：开关成功后重拉体检（包没同步上的提示跟着变）", async () => {
    let checksCalls = 0;
    stubFetch(
      stubs(READY, {
        "/api/health/checks": () => {
          checksCalls += 1;
          return { body: { checks: [READY], passed: 1, total: 1, blockingFailures: [] } };
        },
        "PATCH /api/settings": { body: { ...settings, codexProviderEnabled: true } },
      }),
    );
    renderApp("/settings");
    const toggle = within(await row()).getByRole("switch");
    await waitFor(() => expect(toggle).toBeEnabled());
    const before = checksCalls;
    await userEvent.click(toggle);
    await waitFor(() => expect(checksCalls).toBeGreaterThan(before));
  });
});
