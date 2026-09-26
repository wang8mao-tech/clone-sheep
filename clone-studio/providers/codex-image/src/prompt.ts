/**
 * 交给 Codex 的提示词（REQ-011）：
 * - `$imagegen` 出现且只出现一次：它是触发内置 image_gen 工具的技能名，出现两次 Codex 会当成两次出图
 * - 要求把成品复制到 `./images/<name>.png`：内置工具不接受目标路径，Codex 先生成到
 *   `$CODEX_HOME/generated_images/` 再执行一条复制命令（所以沙箱不能禁命令）
 * - 结尾写明只生成图片、不动别的文件
 *
 * 作者的提示词里要是也写了 `$imagegen`，去掉 `$` 保留字面，保证全文只有开头那一次。
 */

export const IMAGEGEN = "$imagegen";
export const ONLY_IMAGE = "仅生成图片；不要写入、复制或修改任何其它文件。";

export interface ImageAsk {
  prompt: string;
  aspectRatio: string;
  resolution: string;
  /** opaque / auto；transparent 在 supports 里就拒了，走不到这里 */
  background?: string;
  /** 参考图张数（文件已经用 --image 附上） */
  references: number;
  /** 产物文件名，不含扩展名 */
  name: string;
}

export function buildPrompt(ask: ImageAsk): string {
  const authored = ask.prompt.split(IMAGEGEN).join("imagegen");
  const lines = [
    `${IMAGEGEN} 按下面的描述生成一张图片。`,
    "",
    authored.trim(),
    "",
    `画面比例：${ask.aspectRatio === "auto" ? "由你决定" : ask.aspectRatio}；分辨率档位：${ask.resolution}。`,
  ];
  if (ask.background === "opaque") lines.push("背景不透明。");
  if (ask.references > 0) lines.push(`附带的 ${ask.references} 张图片是参考图。`);
  lines.push(`生成后把成品复制到 ./images/${ask.name}.png（没有 images 目录就先建）。`);
  lines.push(ONLY_IMAGE);
  return lines.join("\n");
}

/** 测试与自检用：数 `$imagegen` 出现几次 */
export function countImagegen(prompt: string): number {
  return prompt.split(IMAGEGEN).length - 1;
}
