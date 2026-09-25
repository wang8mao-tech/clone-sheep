import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/harness.js";
import type { ModelProfile } from "../../lib/model-profiles.js";
import { DS, hold, row, section, stub, SUB } from "../../test/profiles-kit.js";

/** SCREEN-009「Agent 模型」档案列表与行内动作（REQ-010，Task 10.3） */

describe("档案列表", () => {
  it("空态只有内置订阅：默认、本机订阅、看图 / 搜索徽标、订阅默认模型；不能编辑、不能删；给一句怎么加", async () => {
    stub([SUB]);
    renderApp("/settings");
    const list = await section();
    const sub = row(list, "本机 Claude Code 订阅");
    for (const text of ["默认", "本机订阅", "看图", "搜索", "订阅默认模型", "未验证"])
      expect(sub).toHaveTextContent(text);
    expect(within(sub).queryByRole("button", { name: /编辑|删除|设为默认/ })).toBeNull();
    expect(screen.getByText(/现在只有内置的本机订阅/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agent 模型" })).toHaveAttribute("href", "#models");
  });

  it("兼容端点行：模型 id、base_url、打码 key、无单价徽标；没开搜索就没有搜索徽标", async () => {
    stub([SUB, DS]);
    renderApp("/settings");
    const ds = row(await section(), "DeepSeek");
    for (const text of [
      "兼容端点",
      "deepseek-flash",
      "https://api.deepseek.com/anthropic",
      "sk-••••••••••••abcd",
      "无单价",
    ]) {
      expect(ds).toHaveTextContent(text);
    }
    expect(within(ds).queryByText("搜索")).toBeNull();
    expect(screen.queryByText(/现在只有内置的本机订阅/)).toBeNull();
  });

  it("加载中给骨架；读不到给错误与重试", async () => {
    stub([SUB], { "/api/model-profiles": { status: 500, body: { error: { message: "库坏了" } } } });
    renderApp("/settings");
    expect(await screen.findByText(/读不到模型档案/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
  });
});

describe("行内动作", () => {
  it("测试连接失败：就地展开上游原文（AC-028）；再测成功：原文收起、给一句连接正常", async () => {
    let ok = false;
    stub([SUB, DS], {
      "POST /api/model-profiles/:id/test": () => ({
        body: ok
          ? {
              result: { ok: true, status: 200 },
              stale: false,
              profile: { ...DS, verifiedAt: new Date().toISOString() },
            }
          : { result: { ok: false, status: 401, detail: '{"error":"invalid key"}' }, stale: false, profile: DS },
      }),
    });
    const user = userEvent.setup();
    renderApp("/settings");
    const ds = row(await section(), "DeepSeek");
    await user.click(within(ds).getByRole("button", { name: "测试连接 DeepSeek" }));
    const alert = await screen.findByRole("alert", { name: "「DeepSeek」测试失败" });
    expect(alert).toHaveTextContent("HTTP 401");
    expect(alert).toHaveTextContent('{"error":"invalid key"}');
    ok = true;
    await user.click(within(ds).getByRole("button", { name: "测试连接 DeepSeek" }));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "「DeepSeek」测试失败" })).toBeNull());
    expect(await screen.findByText("「DeepSeek」连接正常")).toBeInTheDocument();
  });

  it("设为默认：打 /default", async () => {
    const hit = vi.fn();
    stub([SUB, DS], {
      "POST /api/model-profiles/:id/default": (_init, url) => {
        hit(url);
        return { body: { profile: { ...DS, isDefault: true } } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(within(row(await section(), "DeepSeek")).getByRole("button", { name: "设为默认 DeepSeek" }));
    await waitFor(() => expect(hit).toHaveBeenCalledWith("/api/model-profiles/p-ds/default"));
  });

  it("删除走 CMP-012：要输入名称；在用删不了，原因写在弹窗里", async () => {
    stub([SUB, DS], {
      "DELETE /api/model-profiles/:id": {
        status: 409,
        body: { error: { code: "PROFILE_IN_USE", message: "还有 1 个没结束的任务在用这个档案" } },
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(within(row(await section(), "DeepSeek")).getByRole("button", { name: "删除 DeepSeek" }));
    const dialog = await screen.findByRole("dialog", { name: "删除模型档案「DeepSeek」" });
    expect(within(dialog).getByRole("button", { name: "删除档案" })).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "DeepSeek");
    await user.click(within(dialog).getByRole("button", { name: "删除档案" }));
    expect(await within(dialog).findByText(/还有 1 个没结束的任务/)).toBeInTheDocument();
  });
});

describe("审查补的用例（10.3 第一轮）", () => {
  it("列表加载中给骨架", async () => {
    stub([SUB]);
    hold((url) => url.endsWith("/api/model-profiles"));
    renderApp("/settings");
    expect(await screen.findByRole("list", { name: "读取模型档案" })).toHaveAttribute("aria-busy", "true");
  });

  it("两行一起测：各自转圈，互不抢（S2-M2）", async () => {
    const other: ModelProfile = { ...DS, id: "p-2", name: "方舟" };
    stub([SUB, DS, other], {
      "POST /api/model-profiles/:id/test": { body: { result: { ok: true }, stale: false } },
    });
    const gate = hold((url, method) => method === "POST" && url.endsWith("/test"));
    const user = userEvent.setup();
    renderApp("/settings");
    const list = await section();
    await user.click(within(row(list, "DeepSeek")).getByRole("button", { name: "测试连接 DeepSeek" }));
    await user.click(within(row(list, "方舟")).getByRole("button", { name: "测试连接 方舟" }));
    await waitFor(() => expect(gate.count()).toBe(2));
    expect(within(row(list, "DeepSeek")).getByRole("button", { name: "测试连接 DeepSeek" })).toBeDisabled();
    expect(within(row(list, "方舟")).getByRole("button", { name: "测试连接 方舟" })).toBeDisabled();
    gate.releaseAll();
    await waitFor(() =>
      expect(within(row(list, "DeepSeek")).getByRole("button", { name: "测试连接 DeepSeek" })).toBeEnabled(),
    );
  });

  it("测试期间被改过：只提示，不摆失败原文；请求本身没成：说状态没变（S1-L3）", async () => {
    let mode: "stale" | "down" = "stale";
    stub([SUB, DS], {
      "POST /api/model-profiles/:id/test": () =>
        mode === "stale"
          ? { body: { result: { ok: false, status: 401, detail: "old" }, stale: true, profile: DS } }
          : { status: 500, body: { error: { message: "后端炸了" } } },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    const ds = row(await section(), "DeepSeek");
    await user.click(within(ds).getByRole("button", { name: "测试连接 DeepSeek" }));
    expect(await screen.findByText("「DeepSeek」测试期间被改过")).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "「DeepSeek」测试失败" })).toBeNull();
    mode = "down";
    await user.click(within(ds).getByRole("button", { name: "测试连接 DeepSeek" }));
    const alert = await screen.findByRole("alert", { name: "「DeepSeek」测试失败" });
    expect(alert).toHaveTextContent("测试请求没有完成，档案状态没变");
    expect(alert).toHaveTextContent("后端炸了");
  });

  it("失败原文说的是旧配置：档案改过之后不再显示", async () => {
    let current = DS;
    stub([SUB, DS], {
      "/api/model-profiles": () => ({ body: { profiles: [SUB, current] } }),
      "POST /api/model-profiles/:id/test": {
        body: { result: { ok: false, status: 401, detail: "bad" }, stale: false, profile: DS },
      },
      "POST /api/model-profiles/:id/default": { body: { profile: DS } },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    const list = await section();
    await user.click(within(row(list, "DeepSeek")).getByRole("button", { name: "测试连接 DeepSeek" }));
    await screen.findByRole("alert", { name: "「DeepSeek」测试失败" });
    // 别处把模型改了；随便一个会重拉列表的动作把新配置拉回来
    current = { ...DS, modelId: "deepseek-v4-pro" };
    await user.click(within(row(list, "DeepSeek")).getByRole("button", { name: "设为默认 DeepSeek" }));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "「DeepSeek」测试失败" })).toBeNull());
  });

  it("删除成功：弹窗关掉、列表重拉", async () => {
    let profiles = [SUB, DS];
    stub([SUB, DS], {
      "/api/model-profiles": () => ({ body: { profiles } }),
      "DELETE /api/model-profiles/:id": () => {
        profiles = [SUB];
        return { body: { ok: true } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(within(row(await section(), "DeepSeek")).getByRole("button", { name: "删除 DeepSeek" }));
    const dialog = await screen.findByRole("dialog", { name: "删除模型档案「DeepSeek」" });
    await user.type(within(dialog).getByRole("textbox"), "DeepSeek");
    await user.click(within(dialog).getByRole("button", { name: "删除档案" }));
    await waitFor(() => expect(screen.queryByText("sk-••••••••••••abcd")).toBeNull());
    expect(screen.queryByRole("dialog", { name: "删除模型档案「DeepSeek」" })).toBeNull();
  });
});
