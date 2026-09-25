import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/harness.js";
import type { ModelProfile } from "../../lib/model-profiles.js";
import { DS, row, section, stub, SUB } from "../../test/profiles-kit.js";

/** SCREEN-009「Agent 模型」添加 / 编辑右侧面板（REQ-010，Task 10.3） */

describe("添加 / 编辑面板", () => {
  it("先选预设（旁边写明需要 API key），选 DeepSeek 带出 base_url 与模型；没填 key 不提交；填了提交兼容端点", async () => {
    const posted = vi.fn();
    stub([SUB], {
      "POST /api/model-profiles": (init) => {
        posted(JSON.parse(init?.body as string));
        return { status: 201, body: { profile: DS } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "添加模型" }));
    const panel = await screen.findByRole("dialog", { name: "添加模型" });
    expect(within(panel).getByText("需要 API key，聊天订阅不可用")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: /DeepSeek/ }));
    const form = await screen.findByRole("dialog", { name: "添加 · DeepSeek" });
    expect(within(form).getByLabelText("base_url")).toHaveValue("https://api.deepseek.com/anthropic");
    expect(within(form).getByLabelText("主模型 id")).toHaveValue("deepseek-flash");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText("要填 API key")).toBeInTheDocument();
    expect(posted).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText("API key"), "sk-real-key-123456");
    await user.type(within(form).getByLabelText("输入单价（$ / 百万 token）"), "0.27");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(posted).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "compatible",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/anthropic",
          token: "sk-real-key-123456",
          modelId: "deepseek-flash",
          priceIn: 0.27,
          priceOut: null,
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /添加/ })).toBeNull());
  });

  it("「本机订阅 · 指定模型」：没有 key 与 base_url 字段；服务端说重名，红字落在档案名下", async () => {
    stub([SUB], {
      "POST /api/model-profiles": {
        status: 409,
        body: { error: { code: "NAME_TAKEN", message: "已经有叫「x」的档案了。" } },
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "添加模型" }));
    await user.click(await screen.findByRole("button", { name: /本机订阅 · 指定模型/ }));
    const form = await screen.findByRole("dialog", { name: "添加 · 本机订阅 · 指定模型" });
    expect(within(form).queryByLabelText("API key")).toBeNull();
    expect(within(form).queryByLabelText("base_url")).toBeNull();
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText("已经有叫「x」的档案了。")).toBeInTheDocument();
    // 落在档案名这一栏下面（字段红边），不是面板底部的通用报错
    expect(within(form).getByLabelText("档案名")).toHaveAttribute("aria-invalid", "true");
  });

  it("编辑：带出原值、key 留空显示打码占位；不填 key 保存不带 token；Esc 关面板", async () => {
    const patched = vi.fn();
    stub([SUB, DS], {
      "PATCH /api/model-profiles/:id": (init) => {
        patched(JSON.parse(init?.body as string));
        return { body: { profile: DS } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(within(row(await section(), "DeepSeek")).getByRole("button", { name: "编辑 DeepSeek" }));
    const form = await screen.findByRole("dialog", { name: "编辑「DeepSeek」" });
    const key = within(form).getByLabelText("API key");
    expect(key).toHaveValue("");
    expect(key).toHaveAttribute("placeholder", "sk-••••••••••••abcd");
    await user.clear(within(form).getByLabelText("主模型 id"));
    await user.type(within(form).getByLabelText("主模型 id"), "deepseek-v4-pro");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patched).toHaveBeenCalled());
    expect(patched.mock.calls[0]![0]).toMatchObject({ modelId: "deepseek-v4-pro" });
    expect(patched.mock.calls[0]![0]).not.toHaveProperty("token");

    await user.click(within(row(await section(), "DeepSeek")).getByRole("button", { name: "编辑 DeepSeek" }));
    await screen.findByRole("dialog", { name: "编辑「DeepSeek」" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑「DeepSeek」" })).toBeNull());
  });
});

describe("面板：审查补的用例（10.3 第一轮）", () => {
  it("面板开着时在删除确认框里按 Esc：只关确认框，面板与草稿还在（S2-M1）", async () => {
    stub([SUB, DS]);
    const user = userEvent.setup();
    renderApp("/settings");
    const list = await section();
    await user.click(within(row(list, "DeepSeek")).getByRole("button", { name: "编辑 DeepSeek" }));
    const panel = await screen.findByRole("dialog", { name: "编辑「DeepSeek」" });
    await user.clear(within(panel).getByLabelText("档案名"));
    await user.type(within(panel).getByLabelText("档案名"), "草稿名");
    await user.click(within(row(list, "DeepSeek")).getByRole("button", { name: "删除 DeepSeek" }));
    const dialog = await screen.findByRole("dialog", { name: "删除模型档案「DeepSeek」" });
    await user.click(within(dialog).getByRole("textbox"));
    // jsdom 不实现 <dialog> 自带的 Esc 关闭；这里验的是面板这边不跟着关
    await user.keyboard("{Escape}");
    const still = screen.getByRole("dialog", { name: "编辑「DeepSeek」" });
    expect(within(still).getByLabelText("档案名")).toHaveValue("草稿名");
  });

  it("客户端校验：base_url 不是 http(s)、单价为负都不提交；换预设回到预设列表", async () => {
    const posted = vi.fn();
    stub([SUB], {
      "POST /api/model-profiles": () => {
        posted();
        return { status: 201, body: { profile: DS } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "添加模型" }));
    await user.click(await screen.findByRole("button", { name: /DeepSeek/ }));
    const form = await screen.findByRole("dialog", { name: "添加 · DeepSeek" });
    await user.clear(within(form).getByLabelText("base_url"));
    await user.type(within(form).getByLabelText("base_url"), "api.deepseek.com");
    await user.type(within(form).getByLabelText("API key"), "sk-real-key-123456");
    await user.type(within(form).getByLabelText("输出单价（$ / 百万 token）"), "-1");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText("要是 http 或 https 地址")).toBeInTheDocument();
    expect(within(form).getByText("单价要是不小于 0 的数")).toBeInTheDocument();
    expect(posted).not.toHaveBeenCalled();
    await user.click(within(form).getByRole("button", { name: "换预设" }));
    expect(await screen.findByRole("list", { name: "预设" })).toBeInTheDocument();
  });

  it("预设读不到：面板里给错误与重试", async () => {
    stub([SUB], { "/api/model-profiles/presets": { status: 500, body: { error: { message: "坏了" } } } });
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "添加模型" }));
    const panel = await screen.findByRole("dialog", { name: "添加模型" });
    expect(await within(panel).findByText(/读不到预设/)).toBeInTheDocument();
  });

  it("打开面板焦点进面板，关掉回到「添加模型」（S2-M4）", async () => {
    stub([SUB]);
    const user = userEvent.setup();
    renderApp("/settings");
    const add = await screen.findByRole("button", { name: "添加模型" });
    await user.click(add);
    const panel = await screen.findByRole("dialog", { name: "添加模型" });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(add).toHaveFocus());
  });
});

describe("面板落焦（10.3 第二轮审查 S2-M4-R）", () => {
  it("添加：落在第一个预设上；选了预设：落在档案名上（不是头部的「关闭」）", async () => {
    stub([SUB]);
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "添加模型" }));
    const first = await screen.findByRole("button", { name: /本机订阅 · 指定模型/ });
    await waitFor(() => expect(first).toHaveFocus());
    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    const form = await screen.findByRole("dialog", { name: "添加 · DeepSeek" });
    await waitFor(() => expect(within(form).getByLabelText("档案名")).toHaveFocus());
  });

  it("编辑：落在档案名上，也不去拉预设", async () => {
    const presets = vi.fn();
    stub([SUB, DS], {
      "/api/model-profiles/presets": () => {
        presets();
        return { body: { presets: [], note: "" } };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(within(row(await section(), "DeepSeek")).getByRole("button", { name: "编辑 DeepSeek" }));
    const form = await screen.findByRole("dialog", { name: "编辑「DeepSeek」" });
    await waitFor(() => expect(within(form).getByLabelText("档案名")).toHaveFocus());
    expect(presets).not.toHaveBeenCalled();
  });

  it("从编辑 A 换到编辑 B 再关：焦点回到「编辑 B」（S2-L1）", async () => {
    const other: ModelProfile = { ...DS, id: "p-2", name: "方舟" };
    stub([SUB, DS, other]);
    const user = userEvent.setup();
    renderApp("/settings");
    const list = await section();
    await user.click(within(row(list, "DeepSeek")).getByRole("button", { name: "编辑 DeepSeek" }));
    await screen.findByRole("dialog", { name: "编辑「DeepSeek」" });
    const editB = within(row(list, "方舟")).getByRole("button", { name: "编辑 方舟" });
    await user.click(editB);
    await screen.findByRole("dialog", { name: "编辑「方舟」" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(editB).toHaveFocus());
  });

  it("正在编辑的档案被删了：面板跟着关（S2-L2）", async () => {
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
    const list = await section();
    await user.click(within(row(list, "DeepSeek")).getByRole("button", { name: "编辑 DeepSeek" }));
    await screen.findByRole("dialog", { name: "编辑「DeepSeek」" });
    await user.click(within(row(list, "DeepSeek")).getByRole("button", { name: "删除 DeepSeek" }));
    const dialog = await screen.findByRole("dialog", { name: "删除模型档案「DeepSeek」" });
    await user.type(within(dialog).getByRole("textbox"), "DeepSeek");
    await user.click(within(dialog).getByRole("button", { name: "删除档案" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑「DeepSeek」" })).toBeNull());
  });
});
