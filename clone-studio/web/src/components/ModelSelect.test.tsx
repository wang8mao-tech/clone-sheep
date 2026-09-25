import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { ModelProfile } from "../lib/model-profiles.js";
import { DS, SUB } from "../test/profiles-kit.js";
import type { ProfileNeed } from "../lib/profile-choice.js";
import { ModelSelect } from "./ModelSelect.js";

/** CMP-010 模型档案选择器（REQ-010，Task 10.4） */

const BLIND: ModelProfile = { ...DS, id: "p-blind", name: "方舟", supportsVision: false, supportsWebSearch: false };
const NOKEY: ModelProfile = { ...DS, id: "p-nokey", name: "没 key", token: null };

function Harness({ profiles, need, initial }: { profiles: ModelProfile[]; need: ProfileNeed; initial: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <MemoryRouter>
      <ModelSelect profiles={profiles} need={need} value={value} onChange={setValue} />
    </MemoryRouter>
  );
}

afterEach(() => {
  window.localStorage.clear();
});

describe("ModelSelect（CMP-010）", () => {
  it("选项：档案名 + 模型 id；复刻要看图，不看图的与没 key 的置灰并把原因写进选项文字", () => {
    render(<Harness profiles={[SUB, DS, BLIND, NOKEY]} need="vision" initial="subscription" />);
    const select = screen.getByLabelText("Agent 模型");
    expect(within(select).getByRole("option", { name: "本机 Claude Code 订阅 · 订阅默认模型" })).toBeEnabled();
    expect(within(select).getByRole("option", { name: "DeepSeek · deepseek-flash" })).toBeEnabled();
    expect(
      within(select).getByRole("option", { name: "方舟（不可选：不支持看图，复刻要看参考视频的帧） · deepseek-flash" }),
    ).toBeDisabled();
    expect(within(select).getByRole("option", { name: /没 key（不可选：还没有 API key）/ })).toBeDisabled();
    expect(screen.getByRole("link", { name: "管理模型…" })).toHaveAttribute("href", "/settings#models");
  });

  it("变体不强求看图：不看图的能选，选了提示；没原生搜索的提示缺口可能偏多；徽标跟着选中项", async () => {
    render(<Harness profiles={[SUB, BLIND]} need={null} initial="subscription" />);
    expect(screen.getByText("本机订阅")).toBeInTheDocument();
    expect(screen.getByText("看图")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Agent 模型"), "p-blind");
    expect(screen.getByText(/这个档案不支持看图/)).toBeInTheDocument();
    expect(screen.getByText(/没有原生联网搜索/)).toBeInTheDocument();
    expect(screen.queryByText("看图")).toBeNull();
    expect(screen.getByText("兼容端点")).toBeInTheDocument();
  });

  it("首次切到非 Claude 档案：提醒一次，点「知道了」之后不再出现（REQ-010 SHOULD）", async () => {
    const { unmount } = render(<Harness profiles={[SUB, DS]} need={null} initial="subscription" />);
    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Agent 模型"), "p-ds");
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("hypit skill 是按 Claude Code / Codex 级别的 Agent 设计的");
    await userEvent.click(within(note).getByRole("button", { name: "知道了" }));
    expect(screen.queryByRole("note")).toBeNull();
    unmount();
    render(<Harness profiles={[SUB, DS]} need={null} initial="p-ds" />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("一个能用的都没有：写明为什么、去哪补", () => {
    render(<Harness profiles={[BLIND]} need="vision" initial={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("没有支持看图的模型档案");
  });

  it("还没读到档案：下拉不可用，写读取中", () => {
    render(
      <MemoryRouter>
        <ModelSelect profiles={undefined} value={null} onChange={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Agent 模型")).toBeDisabled();
    expect(screen.getByRole("option", { name: "读取模型档案…" })).toBeInTheDocument();
  });
});

describe("ModelSelect：读不到档案（10.4 审查 S2-M1）", () => {
  it("写明读不到、提交会用默认档案，给重试", async () => {
    let retried = 0;
    render(
      <MemoryRouter>
        <ModelSelect
          profiles={undefined}
          value={null}
          onChange={() => undefined}
          error={new Error("后端未响应")}
          onRetry={() => (retried += 1)}
        />
      </MemoryRouter>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("读不到模型档案：后端未响应。提交时会用默认档案。");
    await userEvent.click(within(alert).getByRole("button", { name: "重试" }));
    expect(retried).toBe(1);
    expect(screen.getByRole("option", { name: "读不到模型档案" })).toBeInTheDocument();
  });
});
