import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDrawer } from "./AgentDrawer.js";
import { DrawerFrame } from "./DrawerFrame.js";
import { ToolInput } from "./ToolInput.js";
import { useTypewriter } from "./useTypewriter.js";
import { renderWithProviders } from "../../test/harness.js";
import { installEventSource, type ControlledEventSource } from "../../test/fake-event-source.js";
import { agentMessages as m } from "../../test/agent-fixtures.js";
import { drawerBackend, TPL } from "../../test/agent-drawer-kit.js";

/** 复审第一轮（Task 5.4）逐条补的行为：宽度与键盘、收起不重放、取数失败可重试、工具入参按代码看、流动时长 */

const setViewport = (width: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
};

describe("抽屉宽度（Design-Brief §A.5 / §8.3）", () => {
  const original = window.innerWidth;
  afterEach(() => setViewport(original));

  function frame() {
    render(
      <DrawerFrame open onOpenChange={vi.fn()} header="头">
        内容
      </DrawerFrame>,
    );
    return screen.getByRole("complementary", { name: "Agent 过程" });
  }

  it("1280-1599：固定 420，不给拖宽的分隔条", () => {
    setViewport(1440);
    const aside = frame();
    expect(aside).toHaveStyle({ width: "420px" });
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByTestId("drawer-gutter")).toBeNull();
  });

  it("≥1600：键盘左右键调宽，夹在 420-640 之间（≤360 永远到不了）", async () => {
    const user = userEvent.setup();
    setViewport(1920);
    const aside = frame();
    const sep = screen.getByRole("separator", { name: "拖动调整抽屉宽度" });
    expect(sep).toHaveAttribute("tabindex", "0");
    sep.focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(aside).toHaveStyle({ width: "460px" });
    expect(sep).toHaveAttribute("aria-valuenow", "460");
    for (let i = 0; i < 20; i++) await user.keyboard("{ArrowLeft}");
    expect(aside).toHaveStyle({ width: "640px" });
    for (let i = 0; i < 30; i++) await user.keyboard("{ArrowRight}");
    expect(aside).toHaveStyle({ width: "420px" });
  });

  it("分隔条点击区 28px（§5.3 最小点击区），看得见的线只有 4px（复审 S1-N2）", () => {
    setViewport(1920);
    frame();
    const sep = screen.getByRole("separator");
    // jsdom 没有布局，按类名核对尺寸：w-7 = 28px 居中压在边框上，左半落进抽屉让出来的 14px 空隙（w-3.5），
    // 不盖旁边页面的滚动条（复审 S1-R3-1）；真机量过 elementFromPoint
    expect(sep).toHaveClass("w-7", "-left-3.5");
    expect(sep.firstElementChild).toHaveClass("w-1");
    expect(screen.getByTestId("drawer-gutter")).toHaveClass("w-3.5");
  });

  it("拖宽之后视口变窄：回到 420", async () => {
    const user = userEvent.setup();
    setViewport(1920);
    const aside = frame();
    screen.getByRole("separator").focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(aside).toHaveStyle({ width: "480px" });
    act(() => setViewport(1440));
    expect(aside).toHaveStyle({ width: "420px" });
  });
});

describe("AgentDrawer · 收起再展开 / 取数失败", () => {
  let findSource: ReturnType<typeof installEventSource>;
  beforeEach(() => {
    findSource = installEventSource();
  });

  async function mount(): Promise<ControlledEventSource> {
    renderWithProviders(<AgentDrawer templateId={TPL} />);
    act(() => findSource(`template:${TPL}`)?.open());
    const s = await waitFor(() => {
      const found = findSource("job:job-1");
      if (!found) throw new Error("还没订阅任务主题");
      return found;
    });
    act(() => s.open());
    return s;
  }

  it("收起再展开：流完的回复不重新逐字打一遍，展开过的工具行还开着（复审 S2-M1）", async () => {
    const user = userEvent.setup();
    const { db } = drawerBackend({
      messages: [m.init(1), m.assistant(2, [m.toolUse("t1", "Bash", { command: "ls" })]), m.toolResult(3, "t1", "a")],
    });
    const es = await mount();
    await user.click(await screen.findByRole("button", { name: "Bash ls，成功" }));
    db.messages.push(m.assistant(4, [{ type: "text", text: "新的一段回复".repeat(20) }]));
    act(() => es.emit("agent-message", "job:job-1", { jobId: "job-1", seq: 4, type: "assistant" }));
    // 先等它真开始流（光标出现），再等流完，才算「流完了」
    await screen.findByTestId("stream-cursor");
    await waitFor(() => expect(screen.queryByTestId("stream-cursor")).toBeNull(), { timeout: 3000 });

    await user.click(screen.getByRole("button", { name: "收起 Agent 过程抽屉" }));
    expect(screen.queryByRole("complementary", { name: "Agent 过程" })).toBeNull();
    // 收着也看得见后台有任务在跑（复审 S2-L6）
    expect(screen.getByRole("img", { name: "Agent 任务运行中" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开 Agent 过程抽屉" }));
    expect(screen.queryByTestId("stream-cursor")).toBeNull();
    expect(screen.getByRole("button", { name: "Bash ls，成功" })).toHaveAttribute("aria-expanded", "true");
  });

  it("快照拉失败：抽屉自己展开，给原文和「重试」，不说「还没有任务」；重试成功后出任务（复审 S1-M7）", async () => {
    const user = userEvent.setup();
    let fail = true;
    drawerBackend(
      { messages: [m.init(1), m.assistant(2, [{ type: "text", text: "在跑" }])] },
      {
        [`/api/templates/${TPL}/agent-job`]: () =>
          fail
            ? { status: 500, body: { error: { message: "数据库忙" } } }
            : {
                body: {
                  job: jobBody(),
                  messages: [m.init(1), m.assistant(2, [{ type: "text", text: "在跑" }])],
                  hasOlder: false,
                  hasNewer: false,
                  firstSeq: 1,
                  lastSeq: 2,
                  nextSeq: 2,
                  jobLastSeq: 2,
                },
              },
      },
    );
    renderWithProviders(<AgentDrawer templateId={TPL} />);
    act(() => findSource(`template:${TPL}`)?.open());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("读取 Agent 消息失败：数据库忙");
    expect(screen.getByRole("complementary", { name: "Agent 过程" })).toBeVisible();
    expect(screen.queryByText("这个模板还没有 Agent 任务。")).toBeNull();
    fail = false;
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("在跑")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

function jobBody() {
  return {
    id: "job-1",
    ownerKind: "template",
    ownerId: TPL,
    status: "running",
    sessionId: "s-1",
    startedAt: "2026-09-23T10:00:00.000Z",
    runStartedAt: "2026-09-23T10:00:00.000Z",
    runElapsedMs: 0,
    endedAt: null,
    costUsd: 0,
    costIsEstimate: true,
    stopReason: null,
    profileName: null,
    modelId: null,
    resumeAt: null,
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: null,
  };
}

describe("工具入参按代码看（复审 S1-M5）", () => {
  it("写 .svml：内容按 XML 高亮成代码块、>20 行折叠；路径等其余参数照 JSON", () => {
    const svml = Array.from({ length: 30 }, (_, i) => `<scene id="s${i}"></scene>`).join("\n");
    render(<ToolInput name="Write" input={{ file_path: "reference.svml", content: svml }} />);
    expect(screen.getByText("内容")).toBeInTheDocument();
    const pre = document.querySelectorAll("pre");
    expect(pre[0]).toHaveTextContent('"file_path": "reference.svml"');
    expect(pre[0]).not.toHaveTextContent("scene");
    expect(pre[1]).toHaveAttribute("data-folded", "true");
    expect(pre[1]?.querySelector(".hljs-tag, .hljs-name")).not.toBeNull();
    expect(pre[1]?.textContent).toContain('<scene id="s0"></scene>\n<scene id="s1">');
  });

  it("改文件给替换前 / 替换后两块；命令按 bash；内容里有 ``` 也包得住", () => {
    const { unmount } = render(
      <ToolInput name="Edit" input={{ file_path: "a.md", old_string: "```\nx\n```", new_string: "y" }} />,
    );
    expect(screen.getByText("替换前")).toBeInTheDocument();
    expect(screen.getByText("替换后")).toBeInTheDocument();
    expect(document.querySelectorAll("pre")[1]?.textContent).toContain("```\nx\n```");
    unmount();
    render(<ToolInput name="Bash" input={{ command: "ls -la", description: "列目录" }} />);
    expect(screen.getByText("命令")).toBeInTheDocument();
    expect(document.querySelector("code.language-bash")).toHaveTextContent("ls -la");
  });
});

describe("逐字流式按时间走，不按跳数走", () => {
  it("后台标签页把定时器压到一秒一跳：一跳之后就追上进度，不会把 0.6 秒拖成半分钟（真机实测）", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useTypewriter("字".repeat(3000), true));
      expect(result.current.typing).toBe(true);
      // 墙钟过了一秒，但定时器只轮到一次
      vi.setSystemTime(Date.now() + 1_000);
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(result.current.typing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("逐字流式的时长（复审 S1-M6）", () => {
  it("再长的一段也在 0.6 秒内流完，给落库、推送、拉取留出 1 秒里的余量", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useTypewriter("字".repeat(5000), true));
      // 每一跳都要让 React 渲染一次才会排下一跳：按 16ms 一步推
      const advance = (ms: number) => {
        for (let t = 0; t < ms; t += 16)
          act(() => {
            vi.advanceTimersByTime(16);
          });
      };
      advance(304);
      expect(result.current.typing).toBe(true); // 确实在流，不是一下子全出来
      advance(336);
      expect(result.current).toMatchObject({ typing: false, shown: "字".repeat(5000) });
    } finally {
      vi.useRealTimers();
    }
  });
});
