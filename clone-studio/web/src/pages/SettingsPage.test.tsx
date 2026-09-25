import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { healthStubs, renderApp, stubFetch } from "../test/harness.js";

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

function base(extra: Record<string, unknown> = {}) {
  return {
    ...healthStubs,
    "/api/clients": { body: { clients: [] } },
    "/api/settings": { body: settings },
    "/api/model-profiles": { body: { profiles: [] } },
    ...extra,
  };
}

beforeEach(() => {
  stubFetch(base());
});

describe("设置页：TokenDance 凭据", () => {
  /**
   * 这条钉的是一次真事故：前端发 POST、后端注册的是 PUT，一路 404；
   * 而保存的 mutation 当时没有 onError，失败被完全吞掉——用户点保存毫无反应，
   * 接着点验证又说「未配置 key」，看上去像两个互不相干的 bug。
   * 方法名写错这种事靠人眼防不住，只能靠用例钉住。
   */
  it("保存走 PUT /api/settings/secret，带 key 与 value", async () => {
    const put = vi.fn();
    stubFetch(
      base({
        "PUT /api/settings/secret": (init?: RequestInit) => {
          put(init?.body);
          return { body: { masked: "abc••••••••••••7890" } };
        },
      }),
    );
    renderApp("/settings");

    const input = await screen.findByLabelText("TokenDance API key");
    await userEvent.type(input, "sk-test-1234567890");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(JSON.stringify({ key: "tokendance.apiKey", value: "sk-test-1234567890" })),
    );
  });

  it("保存成功后给一句确认并提示接着验证", async () => {
    stubFetch(base({ "PUT /api/settings/secret": { body: { masked: "abc••••••••••••7890" } } }));
    renderApp("/settings");

    await userEvent.type(await screen.findByLabelText("TokenDance API key"), "sk-test-1234567890");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/已保存/)).toBeInTheDocument();
  });

  /** 保存失败必须说话。静默是这次 bug 最难查的部分 */
  it("保存失败弹 toast，不再静默", async () => {
    stubFetch(
      base({
        "PUT /api/settings/secret": {
          status: 500,
          body: { error: { code: "INTERNAL", message: "写不进 secrets.json" } },
        },
      }),
    );
    renderApp("/settings");

    await userEvent.type(await screen.findByLabelText("TokenDance API key"), "sk-test-1234567890");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("保存失败")).toBeInTheDocument();
  });

  it("没填东西时保存按钮是禁的，并说明原因", async () => {
    renderApp("/settings");
    const save = await screen.findByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("title", "先填入 key");
  });

  it("没保存过 key 时验证按钮是禁的——验证一个不存在的 key 没有意义", async () => {
    renderApp("/settings");
    expect(await screen.findByRole("button", { name: "验证" })).toBeDisabled();
  });

  /** AC-023：验证失败要显示服务端返回的原因原文 */
  it("验证失败原样显示服务端的状态码与响应体", async () => {
    stubFetch(
      base({
        "/api/settings": {
          body: { ...settings, credentials: { ...settings.credentials, tokendance: "abc••••••••••••7890" } },
        },
        "POST /api/settings/verify/tokendance": {
          body: { ok: false, status: 401, detail: '{"code":40100,"message":"invalid api key"}' },
        },
      }),
    );
    renderApp("/settings");

    await userEvent.click(await screen.findByRole("button", { name: "验证" }));

    expect(await screen.findByText("TokenDance key 验证失败")).toBeInTheDocument();
    expect(screen.getByText(/HTTP 401/)).toBeInTheDocument();
    expect(screen.getByText(/invalid api key/)).toBeInTheDocument();
  });

  it("验证通过给一句确认", async () => {
    stubFetch(
      base({
        "/api/settings": {
          body: { ...settings, credentials: { ...settings.credentials, tokendance: "abc••••••••••••7890" } },
        },
        "POST /api/settings/verify/tokendance": { body: { ok: true } },
      }),
    );
    renderApp("/settings");

    await userEvent.click(await screen.findByRole("button", { name: "验证" }));
    expect(await screen.findByText("TokenDance key 验证通过")).toBeInTheDocument();
  });
});

describe("设置页：从「管理模型…」带锚点过来", () => {
  it("#models：滚到「Agent 模型」这一组", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderApp("/settings#models");
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect((scroll.mock.contexts[0] as HTMLElement).id).toBe("models");
  });
});
