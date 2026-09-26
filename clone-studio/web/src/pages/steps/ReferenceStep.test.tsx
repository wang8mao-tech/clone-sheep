import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/harness.js";
import {
  BASE,
  bodyOf,
  detail,
  EVIDENCE,
  evidence,
  IDLE,
  PENDING,
  row,
  stub,
  TPL_ID,
} from "../../test/reference-fixtures.js";
import { DS, SUB } from "../../test/profiles-kit.js";

beforeEach(() => {
  stub("importing", IDLE);
});

describe("① 参考 · 默认态", () => {
  it("未提交时只有表单，右侧给提示而不是空清单", async () => {
    renderApp(`${BASE}/reference`);
    expect(await screen.findByRole("form", { name: "导入参考视频" })).toBeInTheDocument();
    expect(screen.getByText("提交后这里显示参考视频和证据准备进度。")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "证据准备清单" })).not.toBeInTheDocument();
    // 时长上限来自设置，不是写死的
    expect(screen.getByText(/3-180 秒/)).toBeInTheDocument();
    expect(screen.getByLabelText("模板名")).toHaveValue("足球榜单");
  });
});

describe("① 参考 · 链接提交", () => {
  it("非 http/https 链接就地红字，不发请求", async () => {
    const user = userEvent.setup();
    renderApp(`${BASE}/reference`);
    await user.type(await screen.findByLabelText("视频链接"), "ftp://x.com/a.mp4");
    await user.click(screen.getByRole("button", { name: "开始复刻" }));
    expect(await screen.findByText("只支持 http/https 链接。")).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(calls).toHaveLength(0);
  });

  it("合法链接提交后带上语言与备注，右侧出现四步清单", async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> | undefined;
    stub("importing", IDLE, {
      [`POST ${EVIDENCE}`]: (init) => {
        sent = bodyOf(init);
        return {
          body: evidence("running", [
            ["fetch", "running", { startedAt: new Date().toISOString() }],
            ...PENDING.slice(1),
          ]),
        };
      },
    });
    renderApp(`${BASE}/reference`);
    await user.type(await screen.findByLabelText("视频链接"), "https://www.youtube.com/shorts/abc");
    await user.selectOptions(screen.getByLabelText("视频语言"), "en");
    await user.type(screen.getByLabelText("复刻备注"), "保留节奏");
    await user.click(screen.getByRole("button", { name: "开始复刻" }));

    expect(await screen.findByRole("list", { name: "证据准备清单" })).toBeInTheDocument();
    // 模型档案默认是内置订阅（CMP-010）
    expect(sent).toEqual({
      language: "en",
      note: "保留节奏",
      profileId: "subscription",
      url: "https://www.youtube.com/shorts/abc",
    });
    expect(row(/^下载：进行中/)).toBeInTheDocument();
    expect(row(/^抽帧拼图：等待/)).toBeInTheDocument();
    // 跑着的时候表单锁住，后端此时也会拒
    expect(screen.getByRole("button", { name: "开始复刻" })).toBeDisabled();
  });

  it("改了模板名会先改名再点火", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    stub("importing", IDLE, {
      [`PATCH /api/templates/${TPL_ID}`]: (init) => {
        order.push(`rename:${String(bodyOf(init).name)}`);
        return { body: detail("importing", { name: "新名字" }) };
      },
      [`POST ${EVIDENCE}`]: () => {
        order.push("start");
        return { body: evidence("running", PENDING) };
      },
    });
    renderApp(`${BASE}/reference`);
    const name = await screen.findByLabelText("模板名");
    await user.clear(name);
    await user.type(name, "新名字");
    await user.type(screen.getByLabelText("视频链接"), "https://a.com/v");
    await user.click(screen.getByRole("button", { name: "开始复刻" }));
    await waitFor(() => expect(order).toEqual(["rename:新名字", "start"]));
  });

  it("改名撞名时红字贴在模板名下，不点火", async () => {
    const user = userEvent.setup();
    const start = vi.fn(() => ({ body: IDLE }));
    stub("importing", IDLE, {
      [`PATCH /api/templates/${TPL_ID}`]: {
        status: 409,
        body: { error: { code: "NAME_TAKEN", message: "名称已存在" } },
      },
      [`POST ${EVIDENCE}`]: start,
    });
    renderApp(`${BASE}/reference`);
    const name = await screen.findByLabelText("模板名");
    await user.clear(name);
    await user.type(name, "撞名");
    await user.type(screen.getByLabelText("视频链接"), "https://a.com/v");
    await user.click(screen.getByRole("button", { name: "开始复刻" }));
    expect(await screen.findByText("名称已存在")).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("① 参考 · 上传", () => {
  it("扩展名不对就地拒，不上传", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderApp(`${BASE}/reference`);
    await user.click(await screen.findByRole("radio", { name: "上传文件" }));
    await user.upload(screen.getByLabelText("选择视频文件"), new File(["x"], "a.txt", { type: "text/plain" }));
    expect(await screen.findByText("只支持 mp4 / mov / webm。")).toBeInTheDocument();
  });

  it("没选文件就提交给出提示", async () => {
    const user = userEvent.setup();
    renderApp(`${BASE}/reference`);
    await user.click(await screen.findByRole("radio", { name: "上传文件" }));
    await user.click(screen.getByRole("button", { name: "开始复刻" }));
    expect(await screen.findByText("先选一个视频文件。")).toBeInTheDocument();
  });

  it("先上传拿到 uploadPath，再用它点火", async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> | undefined;
    stub("importing", IDLE, {
      "POST /api/uploads": (init) => {
        expect(init?.body).toBeInstanceOf(FormData);
        return { body: { uploadPath: "C:/data/uploads/u1.mp4", filename: "v.mp4", size: 3 } };
      },
      [`POST ${EVIDENCE}`]: (init) => {
        sent = bodyOf(init);
        return { body: evidence("running", PENDING) };
      },
    });
    renderApp(`${BASE}/reference`);
    await user.click(await screen.findByRole("radio", { name: "上传文件" }));
    await user.upload(screen.getByLabelText("选择视频文件"), new File(["abc"], "v.mp4", { type: "video/mp4" }));
    await user.click(screen.getByRole("button", { name: "开始复刻" }));
    await waitFor(() =>
      expect(sent).toEqual({ language: "zh", profileId: "subscription", uploadPath: "C:/data/uploads/u1.mp4" }),
    );
  });

  it("后端拒收（超 500 MB）时红字贴在文件下", async () => {
    const user = userEvent.setup();
    stub("importing", IDLE, {
      "POST /api/uploads": { status: 413, body: { error: { code: "FILE_TOO_LARGE", message: "文件超过 500 MB。" } } },
    });
    renderApp(`${BASE}/reference`);
    await user.click(await screen.findByRole("radio", { name: "上传文件" }));
    await user.upload(screen.getByLabelText("选择视频文件"), new File(["abc"], "v.mp4", { type: "video/mp4" }));
    await user.click(screen.getByRole("button", { name: "开始复刻" }));
    expect(await screen.findByText("文件超过 500 MB。")).toBeInTheDocument();
  });
});

describe("① 参考 · 刷新后恢复", () => {
  it("清单状态、探测结果、耗时都从后端快照恢复", async () => {
    stub(
      "importing",
      evidence(
        "running",
        [
          ["fetch", "done", { durationMs: 14_000, endedAt: "2026-09-22T01:00:00.000Z" }],
          ["probe", "done", { durationMs: 2_000 }],
          ["transcribe", "running", { startedAt: new Date(Date.now() - 42_000).toISOString() }],
          ["tiles", "pending"],
        ],
        { probe: { duration: 38, hasVideo: true, hasAudio: true, width: 1080, height: 1920, frameRate: 30 } },
      ),
    );
    renderApp(`${BASE}/reference`);
    expect(await screen.findByRole("list", { name: "证据准备清单" })).toBeInTheDocument();
    expect(within(row(/^下载：完成/)).getByText("0:14")).toBeInTheDocument();
    expect(within(row(/^探测：完成/)).getByText("0:38 · 1080×1920 · 30fps")).toBeInTheDocument();
    expect(within(row(/^转写（本地 WhisperX）：进行中/)).getByText("转写中")).toBeInTheDocument();
    expect(within(row(/^转写/)).getByText(/^0:4\d$/)).toBeInTheDocument();
    // 源视频已落盘，播放器指向带 Range 的播放接口
    expect(screen.getByLabelText("参考视频")).toHaveAttribute(
      "src",
      expect.stringContaining(`/api/templates/${TPL_ID}/reference/video`),
    );
  });
});

describe("① 参考 · 审查补的边界", () => {
  it("页头改了名再提交：表单跟着显示新名字，不会发第二个 PATCH 把名字改回去", async () => {
    const user = userEvent.setup();
    let name = "足球榜单";
    const patches: string[] = [];
    stub("importing", IDLE, {
      [`/api/templates/${TPL_ID}`]: () => ({ body: detail("importing", { name, evidenceStatus: "idle" }) }),
      [`PATCH /api/templates/${TPL_ID}`]: (init) => {
        name = String(bodyOf(init).name);
        patches.push(name);
        return { body: detail("importing", { name }) };
      },
      [`POST ${EVIDENCE}`]: { body: evidence("running", PENDING) },
    });
    renderApp(`${BASE}/reference`);
    // 在页头就地改名
    await user.click(await screen.findByRole("button", { name: "足球榜单" }));
    const editor = screen.getByPlaceholderText("模板名");
    await user.clear(editor);
    await user.type(editor, "页头改的名{Enter}");
    await waitFor(() => expect(screen.getByLabelText("模板名")).toHaveValue("页头改的名"));

    await user.type(screen.getByLabelText("视频链接"), "https://a.com/v");
    await user.click(screen.getByRole("button", { name: "开始复刻" }));
    expect(await screen.findByRole("list", { name: "证据准备清单" })).toBeInTheDocument();
    expect(patches).toEqual(["页头改的名"]);
  });

  it("选了超过 500 MB 的文件：就地拒，不发上传请求", async () => {
    const user = userEvent.setup();
    renderApp(`${BASE}/reference`);
    await user.click(await screen.findByRole("radio", { name: "上传文件" }));
    const big = new File(["x"], "big.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: 600 * 1024 * 1024 });
    await user.upload(screen.getByLabelText("选择视频文件"), big);
    expect(await screen.findByText("文件 600 MB，超过 500 MB 上限。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始复刻" }));
    expect(vi.mocked(fetch).mock.calls.some(([u]) => typeof u === "string" && u.includes("/api/uploads"))).toBe(false);
  });

  it("上传时连不上后端：提示中文原因，不是英文的 Failed to fetch", async () => {
    const user = userEvent.setup();
    stub("importing", IDLE, {
      "POST /api/uploads": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderApp(`${BASE}/reference`);
    await user.click(await screen.findByRole("radio", { name: "上传文件" }));
    await user.upload(screen.getByLabelText("选择视频文件"), new File(["abc"], "v.mp4", { type: "video/mp4" }));
    await user.click(screen.getByRole("button", { name: "开始复刻" }));
    expect(await screen.findByText("上传失败：连不上后端，确认后端在运行后重试。")).toBeInTheDocument();
  });

  it("来源单选组：只有选中项可 Tab 到，方向键切换", async () => {
    const user = userEvent.setup();
    renderApp(`${BASE}/reference`);
    const link = await screen.findByRole("radio", { name: "粘贴链接" });
    const upload = screen.getByRole("radio", { name: "上传文件" });
    expect(link).toHaveAttribute("tabindex", "0");
    expect(upload).toHaveAttribute("tabindex", "-1");
    link.focus();
    await user.keyboard("{ArrowRight}");
    expect(upload).toHaveAttribute("aria-checked", "true");
    expect(upload).toHaveFocus();
  });
});

describe("① 参考 · 模型档案（CMP-010，REQ-010 MUST，AC-027 前端）", () => {
  it("不支持看图的档案置灰；一个支持看图的都没有：开始复刻不可点，写明原因", async () => {
    const blind = { ...DS, id: "p-blind", name: "方舟", supportsVision: false, isDefault: true };
    stub("importing", IDLE, { "/api/model-profiles": { body: { profiles: [blind] } } });
    renderApp(`${BASE}/reference`);
    const select = await screen.findByLabelText("Agent 模型");
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: /方舟（不可选：不支持看图/ })).toBeDisabled(),
    );
    expect(await screen.findByText(/没有支持看图的模型档案/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始复刻" })).toBeDisabled();
  });

  it("选了别的支持看图的档案：提交时带上它", async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> | undefined;
    stub("importing", IDLE, {
      "/api/model-profiles": { body: { profiles: [SUB, DS] } },
      [`POST ${EVIDENCE}`]: (init) => {
        sent = bodyOf(init);
        return {
          body: evidence("running", [
            ["fetch", "running", { startedAt: new Date().toISOString() }],
            ...PENDING.slice(1),
          ]),
        };
      },
    });
    renderApp(`${BASE}/reference`);
    await user.type(await screen.findByLabelText("视频链接"), "https://www.youtube.com/shorts/abc");
    await user.selectOptions(await screen.findByLabelText("Agent 模型"), "p-ds");
    await user.click(screen.getByRole("button", { name: "开始复刻" }));
    await waitFor(() => expect(sent).toMatchObject({ profileId: "p-ds" }));
  });
});
