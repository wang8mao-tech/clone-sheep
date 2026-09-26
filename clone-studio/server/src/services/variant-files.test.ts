import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { until, useCloneSandbox } from "./clone-test-kit.js";
import { bootVariants } from "./variant-test-kit.js";

/**
 * 重跑清理不能跟着链接删到变体目录外面去（8.1 第二轮审查 HIGH-1）：Agent 在自己的目录里建 junction 是被允许的写入，
 * 宿主清理时若顺着它走，就会替 Agent 删掉外面的文件
 */

useCloneSandbox();

async function variantDir() {
  const b = await bootVariants();
  const id = b.submit(["换成手机品牌排行榜"]).variants[0]?.id as string;
  await until(() => b.calls.length === 1, "会话开跑");
  return { b, id, dir: b.dirOf(id) };
}

function outsideTree(): string {
  const outside = mkdtempSync(path.join(tmpdir(), "cs-outside-"));
  writeFileSync(path.join(outside, "precious.txt"), "keep me", "utf8");
  mkdirSync(path.join(outside, "sub"));
  writeFileSync(path.join(outside, "sub", "deep.txt"), "keep me too", "utf8");
  return outside;
}

describe("resetVariantProducts 不跟随链接", () => {
  it("assets 本身是指到外面的 junction：只拆掉链接，外面的文件一个不少；重建空的 assets", async () => {
    const { b, dir } = await variantDir();
    const outside = outsideTree();
    try {
      rmSync(path.join(dir, "assets"), { recursive: true, force: true });
      symlinkSync(outside, path.join(dir, "assets"), "junction");
      b.files.resetVariantProducts(dir, [], b.workspace);
      expect(existsSync(path.join(outside, "precious.txt"))).toBe(true);
      expect(existsSync(path.join(outside, "sub", "deep.txt"))).toBe(true);
      expect(readdirSync(path.join(dir, "assets"))).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("assets 里套了一个指到外面的 junction、顶层还有一个：都只拆链接", async () => {
    const { b, dir } = await variantDir();
    const outside = outsideTree();
    try {
      writeFileSync(path.join(dir, "assets", "01-a.jpg"), "agent", "utf8");
      symlinkSync(outside, path.join(dir, "assets", "linked"), "junction");
      symlinkSync(outside, path.join(dir, "elsewhere"), "junction");
      b.files.resetVariantProducts(dir, [], b.workspace);
      expect(readdirSync(outside).sort()).toEqual(["precious.txt", "sub"]);
      expect(existsSync(path.join(outside, "sub", "deep.txt"))).toBe(true);
      expect(existsSync(path.join(dir, "elsewhere"))).toBe(false);
      expect(readdirSync(path.join(dir, "assets"))).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("原稿被做成指到外面文件的硬链接：重跑拆掉它、重拷一份干净的，外面的文件不被改写（8.1 第三轮审查 HIGH-1）", async () => {
    const { b, dir } = await variantDir();
    const outside = outsideTree();
    try {
      const victim = path.join(outside, "precious.txt");
      rmSync(path.join(dir, "reference.svrun"));
      linkSync(victim, path.join(dir, "reference.svrun"));
      b.files.resetVariantProducts(dir, [], b.workspace);
      expect(readFileSync(victim, "utf8")).toBe("keep me");
      expect(readFileSync(path.join(dir, "reference.svrun"), "utf8")).toBe("# reference.svrun\n");
      expect(statSync(path.join(dir, "reference.svrun")).nlink).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("原稿硬链接到模板自己的 reference.svrun：重跑后断开，新会话再改也改不到模板的原稿", async () => {
    const { b, dir } = await variantDir();
    const templateRun = path.join(b.workspace, "reference.svrun");
    rmSync(path.join(dir, "reference.svrun"));
    linkSync(templateRun, path.join(dir, "reference.svrun"));
    writeFileSync(path.join(dir, "reference.svrun"), "# agent edited\n", "utf8");
    // 模板原稿已经被改了（这是 Agent 会话时发生的），重跑至少要断开链接、之后不再连着
    writeFileSync(templateRun, "# reference.svrun\n", "utf8");
    b.files.resetVariantProducts(dir, [], b.workspace);
    writeFileSync(path.join(dir, "reference.svrun"), "# next session edit\n", "utf8");
    expect(readFileSync(templateRun, "utf8")).toBe("# reference.svrun\n");
  });

  it("拿不到模板目录时：普通原稿留着，硬链接的拆掉", async () => {
    const { b, dir } = await variantDir();
    const outside = outsideTree();
    try {
      rmSync(path.join(dir, "reference.svml"));
      linkSync(path.join(outside, "precious.txt"), path.join(dir, "reference.svml"));
      b.files.resetVariantProducts(dir, []);
      expect(existsSync(path.join(dir, "reference.svrun"))).toBe(true);
      expect(existsSync(path.join(dir, "reference.svml"))).toBe(false);
      expect(readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("keep me");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "assets 被改名成 Assets（NTFS 不分大小写）：照样只清 Agent 的图，用户的图留下",
    async () => {
      const { b, dir } = await variantDir();
      writeFileSync(path.join(dir, "assets", "01-user.jpg"), "user", "utf8");
      writeFileSync(path.join(dir, "assets", "02-agent.jpg"), "agent", "utf8");
      const { renameSync } = await import("node:fs");
      renameSync(path.join(dir, "assets"), path.join(dir, "Assets"));
      b.files.resetVariantProducts(dir, ["assets/01-user.jpg"], b.workspace);
      expect(readdirSync(path.join(dir, "assets"))).toEqual(["01-user.jpg"]);
    },
  );

  it("用户替换过的图在子目录里也留下；普通子目录里 Agent 的图删掉", async () => {
    const { b, dir } = await variantDir();
    mkdirSync(path.join(dir, "assets", "row"), { recursive: true });
    writeFileSync(path.join(dir, "assets", "row", "01-user.jpg"), "user", "utf8");
    writeFileSync(path.join(dir, "assets", "row", "02-agent.jpg"), "agent", "utf8");
    b.files.resetVariantProducts(dir, ["assets/row/01-user.jpg"], b.workspace);
    expect(readdirSync(path.join(dir, "assets", "row"))).toEqual(["01-user.jpg"]);
  });

  it("不是数据根里的变体目录：一个文件都不动，直接拒绝", async () => {
    const { b } = await variantDir();
    const outside = outsideTree();
    try {
      expect(() => b.files.resetVariantProducts(outside, [], b.workspace)).toThrow(/拒绝清理/);
      expect(() => b.files.resetVariantProducts(b.workspace, [], b.workspace)).toThrow(/拒绝清理/);
      // 长得像变体目录（…/productions/<id>），但在数据根外面
      const lookalike = path.join(outside, "productions", "v1");
      mkdirSync(lookalike, { recursive: true });
      writeFileSync(path.join(lookalike, "keep.txt"), "x", "utf8");
      expect(() => b.files.resetVariantProducts(lookalike, [], b.workspace)).toThrow(/拒绝清理/);
      expect(existsSync(path.join(lookalike, "keep.txt"))).toBe(true);
      expect(existsSync(path.join(outside, "precious.txt"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("变体目录本身被换成指到外面的 junction：拒绝", async () => {
    const { b, dir } = await variantDir();
    const outside = outsideTree();
    try {
      rmSync(dir, { recursive: true, force: true });
      symlinkSync(outside, dir, "junction");
      expect(() => b.files.resetVariantProducts(dir, [], b.workspace)).toThrow(/拒绝清理/);
      expect(readdirSync(outside).sort()).toEqual(["precious.txt", "sub"]);
    } finally {
      rmdirSync(dir);
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
