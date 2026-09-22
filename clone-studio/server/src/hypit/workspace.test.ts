import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRuntimeProfile } from "./workspace.js";

const BASE = { renderWorkers: 4, renderConcurrency: 1 } as const;

describe("buildRuntimeProfile", () => {
  it("没有任何云端服务时，只绑本地能力，profile 仍是完整形态", () => {
    const p = buildRuntimeProfile({ ...BASE, tokendance: false, hypihub: false, whisperx: false });

    expect(p.format).toBe("hypit.runtime-local@1");
    expect(p.dataRoot).toBe(".hypit/execution");
    expect(Object.keys(p.endpoints).sort()).toEqual(["hyperframes.local", "media.local"]);
    // 每个 binding 都必须指向一个真的存在的 endpoint，绑到不存在的实例会在 plan 时才炸
    for (const [capability, instance] of Object.entries(p.bindings)) {
      expect(Object.keys(p.endpoints), `${capability} 绑到了不存在的 ${instance}`).toContain(instance);
    }
  });

  it("TokenDance 开启时带 pool 与 env 凭据引用，明文绝不出现在 profile 里", () => {
    const p = buildRuntimeProfile({ ...BASE, tokendance: true, hypihub: false, whisperx: false });

    const endpoint = p.endpoints["tokendance.default"];
    expect(endpoint).toBeDefined();
    // Provider 的 activation 会对缺 pool 直接抛错
    expect(endpoint?.pool).toBe("tokendance.default");
    expect(endpoint?.config?.apiKey).toEqual({ store: "env", key: "TOKENDANCE_API_KEY" });

    // 整份 profile 序列化后不该含任何疑似密钥的东西
    const text = JSON.stringify(p);
    expect(text).not.toMatch(/sk-|td-[A-Za-z0-9]{8}/);

    expect(p.bindings["@hypit/seedance@1#seedance-2.5"]).toBe("tokendance.default");
    expect(p.bindings["@hypit/seedream@1#seedream-5-lite"]).toBe("tokendance.default");
    expect(p.bindings["@hypit/minimax-h3@1#minimax-h3"]).toBe("tokendance.default");
  });

  it("关掉 TokenDance 时不留下悬空绑定", () => {
    const off = buildRuntimeProfile({ ...BASE, tokendance: false, hypihub: false, whisperx: false });
    expect(Object.keys(off.bindings).some((k) => k.startsWith("@hypit/seedance"))).toBe(false);
    expect(off.endpoints["tokendance.default"]).toBeUndefined();
  });

  it("HypiHub 只加 endpoint、不硬编码能力绑定", () => {
    const p = buildRuntimeProfile({ ...BASE, tokendance: false, hypihub: true, whisperx: false });
    expect(p.endpoints["hypihub.default"]).toBeDefined();
    // 它覆盖哪些能力由它自己的 README 决定；猜着绑不如让 plan 明确报缺能力
    expect(Object.values(p.bindings)).not.toContain("hypihub.default");
  });

  it("渲染并发原样落进 hyperframes 配置", () => {
    const p = buildRuntimeProfile({
      tokendance: false,
      hypihub: false,
      whisperx: false,
      renderWorkers: 8,
      renderConcurrency: 2,
    });
    expect(p.endpoints["hyperframes.local"]?.config).toMatchObject({ workers: 8, defaultConcurrency: 2 });
  });

  it("credentials 永远声明 env store，否则 apiKey 引用解析不了", () => {
    const p = buildRuntimeProfile({ ...BASE, tokendance: true, hypihub: false, whisperx: false });
    expect(p.credentials.env).toEqual({ use: "@hypit/credential-store-env" });
  });
});

describe("createWorkspace", () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-ws-"));
    process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.CLONE_STUDIO_DATA_ROOT;
  });

  async function make() {
    const mod = await import("./workspace.js");
    return {
      mod,
      created: mod.createWorkspace({
        clientId: "c1",
        templateId: "t1",
        slug: "足球榜",
        services: { tokendance: false, hypihub: false, whisperx: true, renderWorkers: 1, renderConcurrency: 1 },
      }),
    };
  }

  it("重跑前清 Agent 产物：宿主建的留下（证据、profile、选择、布局目录），其余顶层条目删光", async () => {
    const { mod, created } = await make();
    const dir = created.dir;
    writeFileSync(path.join(dir, "references", "transcript.json"), "{}");
    writeFileSync(path.join(dir, "assets", "user-replaced.png"), "png");
    writeFileSync(path.join(dir, "ANALYSIS.md"), "x");
    writeFileSync(path.join(dir, "reference.svrun"), "x");
    mkdirSync(path.join(dir, "scratch", "deep"), { recursive: true });

    expect(mod.resetAgentProducts(dir).sort()).toEqual(["ANALYSIS.md", "reference.svrun", "scratch"]);
    for (const rel of [
      "package.json",
      "hypit.runtime.json",
      ".hypit/runtime",
      "references/transcript.json",
      "references/src",
      "assets/user-replaced.png",
      "productions",
    ]) {
      expect(existsSync(path.join(dir, rel)), rel).toBe(true);
    }
    expect(existsSync(path.join(dir, "ANALYSIS.md"))).toBe(false);
  });

  it("清理前先验目录：不在数据根的 clients 下、或没有 profile 的，一个文件都不动（复审 S2-L2）", async () => {
    const { mod } = await make();
    // 位置不对，但 profile 齐全：只有位置检查能拦住它
    const stray = path.join(dataRoot, "stray");
    mkdirSync(stray, { recursive: true });
    writeFileSync(path.join(stray, "hypit.runtime.json"), "{}");
    writeFileSync(path.join(stray, "keep-me.txt"), "x");
    expect(() => mod.resetAgentProducts(stray)).toThrow(/拒绝清理/);
    const noProfile = path.join(dataRoot, "clients", "c9", "templates", "t9");
    mkdirSync(noProfile, { recursive: true });
    writeFileSync(path.join(noProfile, "keep-me.txt"), "x");
    expect(() => mod.resetAgentProducts(noProfile)).toThrow(/拒绝清理/);
    expect(existsSync(path.join(stray, "keep-me.txt"))).toBe(true);
    expect(existsSync(path.join(noProfile, "keep-me.txt"))).toBe(true);
  });

  it("clients 下的 junction 指到外面：按真实路径判，照样拒绝清理（复审 S2-L6）", async () => {
    const { mod } = await make();
    // 工作目录 Agent 可写，它建个 junction 指到数据根外面，字面判断会放行
    const outside = path.join(dataRoot, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "hypit.runtime.json"), "{}");
    writeFileSync(path.join(outside, "keep-me.txt"), "x");
    const link = path.join(dataRoot, "clients", "link");
    symlinkSync(outside, link, "junction");
    try {
      expect(() => mod.resetAgentProducts(link)).toThrow(/拒绝清理/);
      expect(existsSync(path.join(outside, "keep-me.txt"))).toBe(true);
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  });

  it("建出 hypit 认得的工程：package.json + profile + 参考视频目录", async () => {
    const { created } = await make();
    for (const rel of ["package.json", "hypit.runtime.json", "productions", "assets", "references/src"]) {
      expect(existsSync(path.join(created.dir, rel)), rel).toBe(true);
    }
  });

  /**
   * 这条钉的是 Phase 2 漏掉、直接卡死 Phase 4 转写的那一环：
   * hypit 只从该项目的 .hypit/runtime 读选择，不按文件名发现 hypit.runtime.json，
   * 也不继承父目录。只写 profile 不选中，transcribe 一律报
   * 「No Runtime Profile is selected」。
   */
  it("选中 Runtime Profile，内容就是 profile 文件名", async () => {
    const { created } = await make();
    expect(readFileSync(path.join(created.dir, ".hypit", "runtime"), "utf8").trim()).toBe("hypit.runtime.json");
    // .hypit 是执行状态目录，不该进任何版本库
    expect(readFileSync(path.join(created.dir, ".hypit", ".gitignore"), "utf8").trim()).toBe("*");
  });

  it("ensureWorkspaceLayout 能给存量目录补选中（迁移路径）", async () => {
    const { mod, created } = await make();
    const selection = path.join(created.dir, ".hypit", "runtime");

    // 模拟 Phase 2 建出来的存量目录：有 profile，没有选中
    rmSync(path.join(created.dir, ".hypit"), { recursive: true, force: true });
    expect(existsSync(selection)).toBe(false);

    mod.ensureWorkspaceLayout(created.dir);
    expect(readFileSync(selection, "utf8").trim()).toBe("hypit.runtime.json");

    // 再调一次不应该出错，也不该改动内容
    mod.ensureWorkspaceLayout(created.dir);
    expect(readFileSync(selection, "utf8").trim()).toBe("hypit.runtime.json");
  });

  it("目录里没有 profile 时明确报错，而不是写一个指向空气的选择", async () => {
    const { mod } = await make();
    const empty = path.join(dataRoot, "空目录");
    mkdirSync(empty, { recursive: true });
    expect(() => mod.ensureWorkspaceLayout(empty)).toThrowError(/缺少 hypit\.runtime\.json/);
  });

  /**
   * 幂等不是「重复调用不报错」，是「重复调用不重写」。
   * 上一版用例只验了前者，把短路那一行删掉照样全绿——那段成了死代码。
   * 这里用 mtime 钉住：不短路的话，启动迁移会在每次后端启动给每个模板重写。
   */
  it("已经齐全时不重写任何文件", async () => {
    const { mod, created } = await make();
    const selection = path.join(created.dir, ".hypit", "runtime");
    const gitignore = path.join(created.dir, ".hypit", ".gitignore");
    const before = [statSync(selection).mtimeMs, statSync(gitignore).mtimeMs];

    // mtime 在部分文件系统上精度只到毫秒，等一下免得两次写落在同一刻度里
    await new Promise((r) => setTimeout(r, 20));
    mod.ensureWorkspaceLayout(created.dir);

    expect([statSync(selection).mtimeMs, statSync(gitignore).mtimeMs]).toEqual(before);
  });

  it("建目录中途失败时不留半成品（写不进 package.json 的情形）", async () => {
    process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
    vi.resetModules();
    const mod = await import("./workspace.js");
    const dir = mod.workspaceDir("c-fail", "t-fail");

    // 让 package.json 这个名字先被一个目录占住，writeFileSync 必然 EISDIR
    mkdirSync(path.join(dir, "package.json"), { recursive: true });
    // 这不是"本次新建"，所以按设计不该被删掉
    expect(() =>
      mod.createWorkspace({
        clientId: "c-fail",
        templateId: "t-fail",
        slug: "x",
        services: { tokendance: false, hypihub: false, whisperx: true, renderWorkers: 1, renderConcurrency: 1 },
      }),
    ).toThrow();
    expect(existsSync(dir)).toBe(true);

    // 而全新的目录失败后要清掉
    const fresh = mod.workspaceDir("c-fresh", "t-fresh");
    mkdirSync(path.dirname(fresh), { recursive: true });
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("模拟写文件前就炸");
    });
    expect(() =>
      mod.createWorkspace({
        clientId: "c-fresh",
        templateId: "t-fresh",
        slug: "x",
        services: { tokendance: false, hypihub: false, whisperx: true, renderWorkers: 1, renderConcurrency: 1 },
      }),
    ).toThrow();
    spy.mockRestore();
    expect(existsSync(fresh)).toBe(false);
  });
});
