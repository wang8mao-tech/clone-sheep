import { describe, expect, it } from "vitest";
import { formatTimecode, parseTimecode, parseTimeline, splitAnalysis } from "./clone.js";

describe("parseTimeline", () => {
  it("列表、表格、纯行三种写法都认得出时间码；标题与表头跳过；时间码压紧显示", () => {
    const md = [
      "# 时间线",
      "",
      "- 00:00.0-00:03.5 开场，榜单板预置",
      "* **00:03.5 – 00:11** 第一段观点",
      "| 起止 | 内容 |",
      "|---|---|",
      "| 00:11-00:19 | 第二段 | 插图 ×4 |",
      "00:19 收尾停留",
    ].join("\n");
    expect(parseTimeline(md)).toEqual([
      { start: 0, end: 3.5, label: "00:00-00:03.5", text: "开场，榜单板预置" },
      { start: 3.5, end: 11, label: "00:03.5-00:11", text: "第一段观点" },
      { start: 11, end: 19, label: "00:11-00:19", text: "第二段 · 插图 ×4" },
      { start: 19, end: null, label: "00:19", text: "收尾停留" },
    ]);
  });

  it("标题、反引号、方括号、带序号列的表格、箭头起止、带小时的时间码都认得出", () => {
    const md = [
      "### 00:00.0–00:03.5 开场",
      "`00:03.5-00:11.0` 第一段",
      "[00:11 - 00:19] 第二段",
      "| 1 | 00:19-00:20 | 收尾 |",
      "00:20 → 00:22 片尾",
      "1:02:03.5 -> 1:02:05 很长的片子",
    ].join("\n");
    expect(parseTimeline(md).map((r) => [r.start, r.end, r.label, r.text])).toEqual([
      [0, 3.5, "00:00-00:03.5", "开场"],
      [3.5, 11, "00:03.5-00:11", "第一段"],
      [11, 19, "00:11-00:19", "第二段"],
      [19, 20, "00:19-00:20", "收尾"],
      [20, 22, "00:20-00:22", "片尾"],
      [3723.5, 3725, "1:02:03.5-1:02:05", "很长的片子"],
    ]);
  });

  it("时间码行后面的子弹与续行并进这一段的说明，不丢；表格分隔行、空行跳过", () => {
    const md = [
      "- 00:00.0-00:03.5 开场",
      "  - 画面：主持人对镜头",
      "  - 声音：BGM 起",
      "",
      "- 00:03.5-00:11 第一段",
      "|---|---|",
    ].join("\n");
    expect(parseTimeline(md).map((r) => r.text)).toEqual(["开场 · 画面：主持人对镜头 · 声音：BGM 起", "第一段"]);
  });

  it("一行都认不出：返回空数组，页面退回原样渲染", () => {
    expect(parseTimeline("这一段没有时间码\n第二行也没有")).toEqual([]);
  });

  it("时间码换算成秒；整秒的 .0 在显示时去掉", () => {
    expect(parseTimecode("01:02.5")).toBe(62.5);
    expect(parseTimecode("0:07")).toBe(7);
    expect(parseTimecode("1:00:00")).toBe(3600);
    expect(formatTimecode("00:03.0")).toBe("00:03");
    expect(formatTimecode("00:03.50")).toBe("00:03.50");
  });
});

describe("splitAnalysis", () => {
  it("拆出「不确定项」一节的逐条内容，后面同级的节留在正文", () => {
    const md = "## 结构\n榜单。\n\n## 不确定项\n1. 音乐来源不明\n- 字体\n\n## 附录\n别丢";
    const parts = splitAnalysis(md);
    expect(parts.uncertain).toEqual(["音乐来源不明", "字体"]);
    expect(parts.body).toContain("榜单。");
    expect(parts.body).toContain("别丢");
    expect(parts.body).not.toContain("音乐来源不明");
  });

  it("那一节里的引言段落留在正文，条目的缩进续行并进条目，都不丢", () => {
    const md = "## 不确定项\n以下几点要特别看：\n- 背景音乐\n  可能来自曲库 A\n- **字体**：无法识别";
    const parts = splitAnalysis(md);
    expect(parts.uncertain).toEqual(["背景音乐 可能来自曲库 A", "**字体**：无法识别"]);
    expect(parts.body).toBe("## 不确定项\n以下几点要特别看：");
  });

  it("那一节写成段落而不是列表：原样留在正文，不丢内容", () => {
    const md = "## 不确定项\n背景音乐来源无法识别。";
    expect(splitAnalysis(md)).toEqual({ body: md, uncertain: [] });
  });

  it("没有「不确定项」一节：正文原样", () => {
    expect(splitAnalysis("只有正文")).toEqual({ body: "只有正文", uncertain: [] });
  });
});
