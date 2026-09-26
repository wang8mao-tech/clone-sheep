import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourcePathOf, tilesDirOf, transcriptPathOf } from "../services/evidence-steps.js";
import { capabilitySection, clonePrompt, hostSystemAppend, rejectPrompt } from "./prompts.js";

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "cs-prompts-"));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("能力清单（Spec：MUST 写进系统提示，只用可用能力）", () => {
  it("取自 hypit.runtime.json 的 bindings，逐条列出能力 → 端点", () => {
    writeFileSync(
      path.join(ws, "hypit.runtime.json"),
      JSON.stringify({
        bindings: {
          "@hypit/whisperx@1#whisperx-alignment": "whisperx.local",
          "@hypit/render-hyperframes@1#render-visual": "hyperframes.local",
        },
      }),
    );
    const s = capabilitySection(ws);
    expect(s).toContain("- @hypit/render-hyperframes@1#render-visual → hyperframes.local");
    expect(s).toContain("- @hypit/whisperx@1#whisperx-alignment → whisperx.local");
    expect(s).toContain("缺哪种能力");
  });

  it("变体的工作目录（模板目录下的 productions/<id>/）没有 profile：往上用模板目录那份", () => {
    writeFileSync(path.join(ws, "hypit.runtime.json"), JSON.stringify({ bindings: { "cap#x": "local.x" } }));
    const sub = path.join(ws, "productions", "v1");
    mkdirSync(sub, { recursive: true });
    expect(capabilitySection(sub)).toContain("- cap#x → local.x");
  });

  it("往上找到项目根（package.json）为止：项目根外面的 profile 不算这个项目的", () => {
    writeFileSync(path.join(ws, "hypit.runtime.json"), JSON.stringify({ bindings: { "stray#x": "elsewhere" } }));
    const project = path.join(ws, "project");
    const sub = path.join(project, "productions", "v1");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(project, "package.json"), "{}");
    expect(capabilitySection(sub)).not.toContain("stray#x");
    expect(capabilitySection(sub)).toContain("hypit plan");
  });

  it("读不到 profile 时不编造，改为让它先 hypit plan", () => {
    expect(capabilitySection(ws)).toContain("hypit plan");
  });
});

describe("宿主规则追加段", () => {
  it("写明工作目录、出片由宿主负责、被拒别换写法、用 hypit skill", () => {
    const s = hostSystemAppend({ workspace: ws });
    expect(s).toContain(ws);
    expect(s).toContain("出片由宿主负责");
    expect(s).toContain("不要换写法重试");
    expect(s).toContain("clone-studio:hypit");
    expect(s).toContain("--watch");
    // 复审 S1-H6：告诉它 hypit 就在 PATH 上，免得它去找路径或全局安装
    expect(s).toContain("`hypit` 已经在 PATH 上");
  });
});

describe("任务提示", () => {
  it("复刻：指向证据文件、列出交付物、完成标准是 check 通过且不出片", () => {
    const p = clonePrompt({ language: "zh", note: "保留榜单动效" });
    for (const s of [
      "references/src/source.mp4",
      "references/transcript.json",
      "references/tiles",
      "ANALYSIS.md",
      "不确定项",
      "TIMELINE.md",
      "reference.svrun",
      "hypit check reference.svrun --json",
      "不要出片",
      "保留榜单动效",
    ]) {
      expect(p).toContain(s);
    }
  });

  it("复刻：提示里写的证据位置，就是证据流水线实际落盘的位置（防两边各改各的）", () => {
    const rel = (p: string) => path.relative(ws, p).split(path.sep).join("/");
    const p = clonePrompt({ language: "zh" });
    expect(p).toContain(rel(sourcePathOf(ws)));
    expect(p).toContain(rel(transcriptPathOf(ws)));
    expect(p).toContain(`${rel(tilesDirOf(ws))}/*.jpg`);
  });

  it("复刻：没有备注时不留空段落", () => {
    expect(clonePrompt({ language: "zh" })).not.toContain("复刻备注");
  });

  it("打回：带轮次与意见原文，改到 check 通过", () => {
    const p = rejectPrompt("主持人太小", 2);
    expect(p).toContain("#2");
    expect(p).toContain("主持人太小");
    expect(p).toContain("hypit check");
  });
});
