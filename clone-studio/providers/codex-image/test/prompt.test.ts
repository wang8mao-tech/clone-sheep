import { describe, expect, it } from "vitest";
import { buildPrompt, countImagegen, IMAGEGEN, ONLY_IMAGE } from "../src/prompt.js";

const ask = { prompt: "一只红苹果", aspectRatio: "9:16", resolution: "2K", references: 0, name: "codex-image" };

describe("buildPrompt（REQ-011）", () => {
  it("$imagegen 恰好一次，放在开头；结尾是「仅生成图片」；要求复制到 ./images/<name>.png", () => {
    const p = buildPrompt(ask);
    expect(countImagegen(p)).toBe(1);
    expect(p.startsWith(IMAGEGEN)).toBe(true);
    expect(p.trimEnd().endsWith(ONLY_IMAGE)).toBe(true);
    expect(p).toContain("./images/codex-image.png");
    expect(p).toContain("一只红苹果");
    expect(p).toContain("9:16");
    expect(p).toContain("2K");
  });

  it("作者提示词里也写了 $imagegen（一次或多次）：全文仍只有一次", () => {
    const p = buildPrompt({ ...ask, prompt: "用 $imagegen 画，再 $imagegen 一次" });
    expect(countImagegen(p)).toBe(1);
    expect(p).toContain("用 imagegen 画，再 imagegen 一次");
  });

  it("参考图张数与不透明背景写进提示；auto 比例交给模型", () => {
    const p = buildPrompt({ ...ask, aspectRatio: "auto", background: "opaque", references: 2 });
    expect(p).toContain("2 张图片是参考图");
    expect(p).toContain("背景不透明");
    expect(p).toContain("由你决定");
    const plain = buildPrompt(ask);
    expect(plain).not.toContain("参考图");
    expect(plain).not.toContain("背景");
  });
});
