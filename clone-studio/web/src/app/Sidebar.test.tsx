import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { healthStubs, renderApp, stubFetch } from "../test/harness.js";

const CLIENT_ID = "8ba62e60-9ee5-43d5-b021-a1f8f5bf3499";
const TEMPLATE_ID = "a6562a0a-0bab-4484-8aa2-9e2d7127e3a2";

const tree = {
  clients: [
    {
      id: CLIENT_ID,
      name: "老王工作室",
      createdAt: "2026-09-20T04:10:35.093Z",
      templates: [{ id: TEMPLATE_ID, name: "足球榜单", status: "importing" }],
    },
  ],
};

const impact = {
  kind: "client",
  id: CLIENT_ID,
  name: "老王工作室",
  templates: 2,
  productions: 5,
  runningTasks: 1,
  directories: ["C:\\Users\\wacin\\.clone-studio\\clients\\8ba62e60"],
};

function base(extra: Record<string, unknown> = {}) {
  return { ...healthStubs, "/api/clients": { body: tree }, ...extra };
}

/** 打开某一行的「…」菜单并点其中一项 */
async function useRowMenu(rowLabel: string, item: string): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: `${rowLabel} 的操作` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

beforeEach(() => {
  stubFetch(base());
});

describe("侧栏：行尾菜单", () => {
  it("菜单默认收着，点「…」才出来", async () => {
    renderApp("/");
    await screen.findByText("老王工作室");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "老王工作室 的操作" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeInTheDocument();
  });

  it("按 Esc 关掉菜单并把焦点交还「…」按钮——不然键盘用户会丢了位置", async () => {
    renderApp("/");
    await screen.findByText("老王工作室");
    const trigger = screen.getByRole("button", { name: "老王工作室 的操作" });

    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("客户行与模板行各有自己的菜单，不会点串", async () => {
    renderApp("/");
    await screen.findByText("老王工作室");
    await userEvent.click(screen.getByRole("button", { name: "足球榜单 的操作" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "删除" })).toBeInTheDocument();
    expect(screen.getByRole("menu")).toHaveAccessibleName("足球榜单 的操作");
  });
});

describe("侧栏：就地改名", () => {
  it("改名成功后收起输入框并重拉树", async () => {
    const patch = vi.fn();
    stubFetch(
      base({
        [`PATCH /api/clients/${CLIENT_ID}`]: (init?: RequestInit) => {
          patch(init?.body);
          return { body: { id: CLIENT_ID, name: "新名字", createdAt: "2026-09-20T04:10:35.093Z" } };
        },
      }),
    );
    renderApp("/");
    await screen.findByText("老王工作室");

    await useRowMenu("老王工作室", "重命名");
    const input = await screen.findByLabelText("客户名");
    await userEvent.clear(input);
    await userEvent.type(input, "新名字{Enter}");

    await waitFor(() => expect(patch).toHaveBeenCalledWith(JSON.stringify({ name: "新名字" })));
    await waitFor(() => expect(screen.queryByLabelText("客户名")).not.toBeInTheDocument());
  });

  /** AC-003：同名时输入框下红字提示「名称已存在」，且不创建 */
  it("撞上重名时红字留在输入框下，输入框不收走", async () => {
    stubFetch(
      base({
        [`PATCH /api/clients/${CLIENT_ID}`]: {
          status: 409,
          body: { error: { code: "NAME_TAKEN", message: "名称已存在" } },
        },
      }),
    );
    renderApp("/");
    await screen.findByText("老王工作室");

    await useRowMenu("老王工作室", "重命名");
    const input = await screen.findByLabelText("客户名");
    await userEvent.clear(input);
    await userEvent.type(input, "已经有的名字{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("名称已存在");
    expect(screen.getByLabelText("客户名")).toBeInTheDocument();
    expect(screen.getByLabelText("客户名")).toHaveAttribute("aria-invalid", "true");
  });

  it("接着改字就把红字清掉，别让它挂在新名字下面", async () => {
    stubFetch(
      base({
        [`PATCH /api/clients/${CLIENT_ID}`]: {
          status: 409,
          body: { error: { code: "NAME_TAKEN", message: "名称已存在" } },
        },
      }),
    );
    renderApp("/");
    await screen.findByText("老王工作室");

    await useRowMenu("老王工作室", "重命名");
    const input = await screen.findByLabelText("客户名");
    await userEvent.clear(input);
    await userEvent.type(input, "撞名了{Enter}");
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("客户名"), "换一个");
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("按 Esc 取消，不发请求", async () => {
    const patch = vi.fn();
    stubFetch(base({ [`PATCH /api/clients/${CLIENT_ID}`]: () => (patch(), { body: {} }) }));
    renderApp("/");
    await screen.findByText("老王工作室");

    await useRowMenu("老王工作室", "重命名");
    await userEvent.type(await screen.findByLabelText("客户名"), "{Escape}");

    await waitFor(() => expect(screen.queryByLabelText("客户名")).not.toBeInTheDocument());
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByText("老王工作室")).toBeInTheDocument();
  });
});

describe("侧栏：新建客户", () => {
  it("建完收起输入框并重拉树", async () => {
    const post = vi.fn();
    stubFetch(
      base({
        "POST /api/clients": (init?: RequestInit) => {
          post(init?.body);
          return { status: 201, body: { id: "new", name: "计生协会", createdAt: "2026-09-20T05:00:00.000Z" } };
        },
      }),
    );
    renderApp("/");
    await userEvent.click(await screen.findByRole("button", { name: "新客户" }));
    await userEvent.type(await screen.findByLabelText("客户名"), "计生协会{Enter}");

    await waitFor(() => expect(post).toHaveBeenCalledWith(JSON.stringify({ name: "计生协会" })));
    await waitFor(() => expect(screen.queryByLabelText("客户名")).not.toBeInTheDocument());
  });

  it("超长名的提示也贴在输入框下（AC-003 同一条通道）", async () => {
    stubFetch(
      base({
        "POST /api/clients": {
          status: 400,
          body: { error: { code: "NAME_TOO_LONG", message: "客户名最长 40 字" } },
        },
      }),
    );
    renderApp("/");
    await userEvent.click(await screen.findByRole("button", { name: "新客户" }));
    await userEvent.type(await screen.findByLabelText("客户名"), "太长了{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("客户名最长 40 字");
  });
});

describe("侧栏：级联删除", () => {
  it("先问后端影响，再把级联范围和将中止的任务数列进弹窗（CMP-012）", async () => {
    stubFetch(base({ [`/api/clients/${CLIENT_ID}/deletion-impact`]: { body: impact } }));
    renderApp("/");
    await screen.findByText("老王工作室");

    await useRowMenu("老王工作室", "删除");

    expect(await screen.findByText("连带删除 2 个模板")).toBeInTheDocument();
    expect(screen.getByText("连带删除 5 条成片与变体")).toBeInTheDocument();
    expect(screen.getByText("将中止 1 个运行中的任务")).toBeInTheDocument();
    expect(screen.getByText(/不可恢复/)).toBeInTheDocument();
  });

  it("名字没输对就不让确认（FLOW-004 的二次确认）", async () => {
    stubFetch(base({ [`/api/clients/${CLIENT_ID}/deletion-impact`]: { body: impact } }));
    renderApp("/");
    await screen.findByText("老王工作室");
    await useRowMenu("老王工作室", "删除");

    const confirm = await screen.findByRole("button", { name: "删除" });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText("输入「老王工作室」以确认"), "老王工作室");
    expect(confirm).toBeEnabled();
  });

  /** REQ-001：删除失败 toast 显示原因，对象保留 */
  it("删除失败时对象留在树上，原因走 toast", async () => {
    stubFetch(
      base({
        [`/api/clients/${CLIENT_ID}/deletion-impact`]: { body: impact },
        [`DELETE /api/clients/${CLIENT_ID}`]: {
          status: 409,
          body: { error: { code: "DIRECTORY_BUSY", message: "工作目录移不动，文件可能被别的程序占用。" } },
        },
      }),
    );
    renderApp("/");
    await screen.findByText("老王工作室");
    await useRowMenu("老王工作室", "删除");

    await userEvent.type(await screen.findByLabelText("输入「老王工作室」以确认"), "老王工作室");
    await userEvent.click(screen.getByRole("button", { name: "删除" }));

    expect(await screen.findByText("删除失败，对象已保留")).toBeInTheDocument();
    expect(screen.getByText(/工作目录移不动/)).toBeInTheDocument();
    // 对象保留：树上那条还在
    expect(screen.getByText("老王工作室")).toBeInTheDocument();
  });
});
