import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 编排层与步骤执行层的用例。
 *
 * 审查用 7 条变异证明这两层此前一条断言都没有——包括把 REQ-002 的「不吞错」
 * 明着违反掉也没有任何用例响。这里把 hypit 调用替换成假的，真文件系统照用，
 * 验的是顺序、失败即停、重试起点、兜底落点、以及文件操作本身。
 */

let dataRoot: string;
let closeCurrent: (() => void) | undefined;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-evrun-"));
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
});

afterEach(() => {
  try {
    closeCurrent?.();
  } catch {
    // 句柄已经没了就算了
  }
  closeCurrent = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
  vi.restoreAllMocks();
});

/** 记录每步调了什么，并让指定的步骤抛错 */
function fakeHypit(fail?: { at: string; error: Error }) {
  const calls: string[][] = [];
  return {
    calls,
    impl: async (args: readonly string[]) => {
      calls.push([...args]);
      const name = args[0] === "media" ? `media ${args[1]}` : (args[0] as string);
      if (fail && name === fail.at) throw fail.error;
      if (name === "media probe") {
        return { json: { duration: 30, hasVideo: true, hasAudio: true, width: 1080, height: 1920, frameRate: 30 } };
      }
      return { json: { ok: true } };
    },
  };
}

async function seed(fake: ReturnType<typeof fakeHypit>) {
  const cli = await import("../hypit/cli.js");
  vi.spyOn(cli, "runHypit").mockImplementation(fake.impl as unknown as typeof cli.runHypit);
  // 转写前的服务探测会真连 127.0.0.1:8765，结果随机器上服务开没开而变，一律桩掉
  const svc = await import("../hypit/whisperx-service.js");
  const ensure = vi.spyOn(svc, "ensureWhisperX").mockResolvedValue("already-up");

  const dbMod = await import("../db/index.js");
  const migrateMod = await import("../db/migrate.js");
  const archive = await import("./archive.js");
  const evidence = await import("./evidence.js");
  closeCurrent = dbMod.closeDb;
  migrateMod.migrate();

  const client = archive.createClient("老王工作室");
  const template = archive.createTemplate(client.id, "足球榜");
  return {
    evidence,
    archive,
    ensure,
    db: dbMod.db,
    templateId: template.id,
    workspace: template.workspace_path as string,
  };
}

/** 造一个位于上传目录里的假视频文件 */
function fakeUpload(name = "u.mp4"): string {
  const uploads = path.join(dataRoot, "uploads");
  mkdirSync(uploads, { recursive: true });
  const file = path.join(uploads, name);
  writeFileSync(file, "not really a video", "utf8");
  return file;
}

type Evidence = typeof import("./evidence.js");

/**
 * 等后台流水线跑完。
 *
 * 先等它真的开跑（重试刚发出时库里还是上一轮的 failed，直接判会当场返回，
 * 把整条重试跳过去），再等它落定。
 */
async function settle(evidence: Evidence, templateId: string) {
  for (let i = 0; i < 50; i++) {
    if (evidence.evidenceState(templateId).steps.some((s) => s.status === "running")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  for (let i = 0; i < 300; i++) {
    const state = evidence.evidenceState(templateId);
    if (!state.steps.some((s) => s.status === "running")) return state;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("流水线没有在预期时间内结束");
}

describe("编排：顺序与失败即停", () => {
  it("四步按序跑完，模板状态推进到 cloning（REQ-002 成功态）", async () => {
    const fake = fakeHypit();
    const { evidence, db, templateId } = await seed(fake);

    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    const state = await settle(evidence, templateId);

    expect(state.status).toBe("done");
    expect(fake.calls.map((c) => (c[0] === "media" ? `${c[0]} ${c[1]}` : c[0]))).toEqual([
      "media probe",
      "transcribe",
      "media tiles",
    ]);
    const row = db().prepare("SELECT status FROM templates WHERE id = ?").get(templateId) as { status: string };
    expect(row.status).toBe("cloning");
  });

  /** REQ-002 错误态：哪一步失败停在哪一步，后面的不该被跑 */
  it("中间一步失败就停下，后面的步骤不跑，模板状态转 failed", async () => {
    const fake = fakeHypit({ at: "transcribe", error: new Error("转写炸了") });
    const { evidence, db, templateId } = await seed(fake);

    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    const state = await settle(evidence, templateId);

    expect(state.status).toBe("failed");
    expect(state.steps.map((s) => s.status)).toEqual(["done", "done", "failed", "pending"]);
    expect(fake.calls.some((c) => c[1] === "tiles")).toBe(false);
    const row = db().prepare("SELECT status FROM templates WHERE id = ?").get(templateId) as { status: string };
    expect(row.status).toBe("failed");
  });

  it("重试从失败那一步起跑，不从头来", async () => {
    const fake = fakeHypit({ at: "transcribe", error: new Error("转写炸了") });
    const { evidence, templateId } = await seed(fake);
    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    await settle(evidence, templateId);

    // 换成不会失败的假 hypit 再重试，否则它会在同一步再炸一次
    const healthy = fakeHypit();
    const cli = await import("../hypit/cli.js");
    vi.spyOn(cli, "runHypit").mockImplementation(healthy.impl as unknown as typeof cli.runHypit);

    const { db } = await import("../db/index.js");
    const statusOf = (): string =>
      (db().prepare("SELECT status FROM templates WHERE id = ?").get(templateId) as { status: string }).status;
    expect(statusOf()).toBe("failed");

    evidence.retryEvidence(templateId, "transcribe");
    // 重跑期间模板回到 importing，步骤条才会把 ①参考 显示成进行中（Task 4.4 复审 HIGH）
    expect(statusOf()).toBe("importing");
    await settle(evidence, templateId);
    expect(statusOf()).toBe("cloning");

    // 只该有 transcribe 与 tiles，不该再出现 fetch 或 probe
    expect(healthy.calls.map((c) => (c[0] === "media" ? `${c[0]} ${c[1]}` : c[0]))).toEqual([
      "transcribe",
      "media tiles",
    ]);
  });

  it("hypit 的错误原文原样落库，不改写（REQ-002 MUST 不吞错）", async () => {
    const { HypitError } = await import("../hypit/cli.js");
    const fake = fakeHypit({
      at: "media probe",
      error: new HypitError("CLI_ERROR", "yt-dlp could not fetch …404", undefined, "原始 stderr 全文"),
    });
    const { evidence, templateId } = await seed(fake);

    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    const state = await settle(evidence, templateId);

    const probe = state.steps.find((s) => s.step === "probe");
    expect(probe?.errorCode).toBe("CLI_ERROR");
    expect(probe?.errorMessage).toBe("yt-dlp could not fetch …404");
    // BAD_OUTPUT / TIMEOUT 的线索全在 raw 里，丢了就真成了吞错
    expect(probe?.errorRaw).toBe("原始 stderr 全文");
  });

  it("超时标 timeout 而不是 failed，重试通道才认得它", async () => {
    const { HypitError } = await import("../hypit/cli.js");
    const fake = fakeHypit({ at: "transcribe", error: new HypitError("TIMEOUT", "超过 600s 未返回") });
    const { evidence, templateId } = await seed(fake);

    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    const state = await settle(evidence, templateId);

    expect(state.steps.find((s) => s.step === "transcribe")?.status).toBe("timeout");
    expect(() => evidence.retryEvidence(templateId, "transcribe")).not.toThrow();
    // 重试在后台接着跑：等它跑完再收尾，不然它在临时目录删掉之后写库、把目录又建出来
    await settle(evidence, templateId);
  });
});

describe("转写前按当前设置重写 Runtime Profile（11.2 第二轮审查 L-a）", () => {
  it("磁盘上还留着开 Codex 时写的 codex.local：拉 WhisperX 之前换成现在的（没开就不绑）", async () => {
    const fake = fakeHypit();
    const { evidence, templateId, workspace, ensure } = await seed(fake);
    const profile = path.join(workspace, "hypit.runtime.json");
    const stale = JSON.parse(readFileSync(profile, "utf8")) as {
      endpoints: Record<string, unknown>;
      bindings: Record<string, string>;
    };
    stale.endpoints["codex.local"] = {
      use: "@clone-studio/codex-image",
      pool: "codex.local",
      config: { command: "node" },
    };
    stale.bindings["@hypit/gpt-image@1#gpt-image-2"] = "codex.local";
    writeFileSync(profile, JSON.stringify(stale));
    let seen = "";
    ensure.mockImplementation(async () => {
      seen = readFileSync(profile, "utf8");
      return "already-up";
    });

    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    expect((await settle(evidence, templateId)).status).toBe("done");
    expect(seen).not.toBe("");
    expect(seen).not.toContain("codex.local");
  });
});

describe("编排：换源与并发", () => {
  it("换源视频时磁盘上的旧转写与旧拼图一起清掉", async () => {
    const fake = fakeHypit();
    const { evidence, templateId, workspace } = await seed(fake);
    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload("a.mp4") }, language: "zh" });
    await settle(evidence, templateId);

    // 造出上一轮留下的产物
    const transcript = path.join(workspace, "references", "transcript.json");
    const tiles = path.join(workspace, "references", "tiles");
    writeFileSync(transcript, "{}", "utf8");
    mkdirSync(tiles, { recursive: true });
    writeFileSync(path.join(tiles, "old.jpg"), "x", "utf8");

    // 换一条新的源，fetch 这一步就失败
    const failing = fakeHypit({ at: "media prepare-fetch", error: new Error("没网") });
    const cli = await import("../hypit/cli.js");
    vi.spyOn(cli, "runHypit").mockImplementation(failing.impl as unknown as typeof cli.runHypit);
    await evidence.startEvidence({ templateId, source: { kind: "url", url: "https://a.com/b.mp4" }, language: "zh" });
    await settle(evidence, templateId);

    // 不清的话，工作目录里会是「A 片的转写 + A 片的拼图 + 没有源视频」，
    // 而 Phase 5 的 Agent 直接读工作目录，会拿这份错证据去复刻
    expect(existsSync(transcript)).toBe(false);
    expect(existsSync(tiles)).toBe(false);
  });

  it("正在跑时再提交要明确拒绝，不能静默吞掉请求", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const cli = await import("../hypit/cli.js");

    const { evidence, templateId } = await seed(fakeHypit());
    vi.spyOn(cli, "runHypit").mockImplementation((async () => {
      await gate;
      return { json: { duration: 30, hasVideo: true, hasAudio: true } };
    }) as unknown as typeof cli.runHypit);

    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload("a.mp4") }, language: "zh" });
    await expect(
      evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload("b.mp4") }, language: "zh" }),
    ).rejects.toMatchObject({ code: "EVIDENCE_BUSY", status: 409 });

    // 放闸后必须等后台真的跑完再退出用例：不等的话 afterEach 会在流水线还在
    // 查库时把连接关掉，报一堆 "no such table" 的噪音，盖住真正的失败
    release?.();
    await settle(evidence, templateId);
  });

  /**
   * `startEvidence` 的检查与 `run()` 之间隔着 await（清旧产物），两个并发请求
   * 可能双双通过检查。`run()` 里那道闸才是真正兜住并排执行的那一道。
   */
  it("两个请求挤过入口检查时，只有一条流水线真的在跑", async () => {
    const fake = fakeHypit();
    const { evidence, templateId } = await seed(fake);
    const a = fakeUpload("a.mp4");
    const b = fakeUpload("b.mp4");

    // 不 await 第一个，让两个调用都越过 assertNotRunning
    const first = evidence.startEvidence({ templateId, source: { kind: "file", path: a }, language: "zh" });
    const second = evidence
      .startEvidence({ templateId, source: { kind: "file", path: b }, language: "zh" })
      .catch((e: unknown) => e);
    await Promise.all([first, second]);
    await settle(evidence, templateId);

    // 并排跑的话 probe 会被调两次
    expect(fake.calls.filter((c) => c[1] === "probe")).toHaveLength(1);
  });

  it("重试一个已经成功的步骤要被拒绝，不能把后面的产物弄成半新半旧", async () => {
    const fake = fakeHypit({ at: "transcribe", error: new Error("转写炸了") });
    const { evidence, templateId } = await seed(fake);
    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    await settle(evidence, templateId);

    // fetch 已 done、tiles 还 pending，两者都不该放行
    expect(() => evidence.retryEvidence(templateId, "fetch")).toThrow(/不是失败状态/);
    expect(() => evidence.retryEvidence(templateId, "tiles")).toThrow(/不是失败状态/);
  });
});

describe("取源这一步的文件操作", () => {
  it("上传文件搬进工作目录后，source_path 指向工作目录里那一份", async () => {
    const fake = fakeHypit();
    const { evidence, db, templateId, workspace } = await seed(fake);
    const upload = fakeUpload();

    await evidence.startEvidence({ templateId, source: { kind: "file", path: upload }, language: "zh" });
    await settle(evidence, templateId);

    const row = db().prepare("SELECT source_path FROM templates WHERE id = ?").get(templateId) as {
      source_path: string;
    };
    expect(row.source_path).toBe(path.join(workspace, "references", "src", "source.mp4"));
    expect(existsSync(upload)).toBe(false);
    expect(existsSync(row.source_path)).toBe(true);
  });

  /**
   * 这条钉的是一个会毁用户数据的 bug：重试 fetch 时 source_path 已经指向工作
   * 目录里那一份，from 和目的地是同一个文件。先清目的地的话，用户唯一的源视频
   * 就没了，然后报「上传的文件已经不在了，请重新上传」——而它刚被我们删掉。
   */
  it("重试 fetch 不会把工作目录里唯一的源视频删掉", async () => {
    const fake = fakeHypit({ at: "media probe", error: new Error("探测炸了") });
    const { evidence, templateId, workspace } = await seed(fake);
    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    await settle(evidence, templateId);

    const source = path.join(workspace, "references", "src", "source.mp4");
    expect(existsSync(source)).toBe(true);

    // 直接把 fetch 置回失败，模拟「fetch 被标失败、而 source_path 已经指向
    // 工作目录里那一份」这个组合——守卫要守的就是它
    const store = await import("./evidence-store.js");
    store.markFailed(templateId, "fetch", { code: "PIPELINE_ERROR", message: "假装它失败了" });

    evidence.retryEvidence(templateId, "fetch");
    const state = await settle(evidence, templateId);

    expect(existsSync(source)).toBe(true);
    expect(state.steps.find((s) => s.step === "fetch")?.status).toBe("done");
  });

  it("上传路径在上传目录之外时拒绝导入，不当搬运工", async () => {
    const fake = fakeHypit();
    const { evidence, templateId } = await seed(fake);
    const outside = path.join(dataRoot, "secrets.json");
    writeFileSync(outside, '{"key":"x"}', "utf8");

    await evidence.startEvidence({ templateId, source: { kind: "file", path: outside }, language: "zh" });
    const state = await settle(evidence, templateId);

    expect(state.steps.find((s) => s.step === "fetch")?.errorCode).toBe("UPLOAD_OUTSIDE");
    // 拒绝了就不能动它
    expect(existsSync(outside)).toBe(true);
  });

  it("转写前先确保 WhisperX 服务在跑，且在 transcribe 之前", async () => {
    const fake = fakeHypit();
    const { evidence, templateId, workspace, ensure } = await seed(fake);
    // ensure 被调的那一刻 hypit 已经跑过哪些命令：transcribe 必须还没跑
    let ranBeforeEnsure: string[] = [];
    ensure.mockImplementation(async () => {
      ranBeforeEnsure = fake.calls.map((c) => c[0] as string);
      return "started";
    });
    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    const state = await settle(evidence, templateId);

    expect(state.status).toBe("done");
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith(
      workspace,
      expect.objectContaining({ subject: { kind: "template", id: templateId } }),
      expect.objectContaining({ onStarting: expect.any(Function) }),
    );
    expect(ranBeforeEnsure).not.toContain("transcribe");
    expect(fake.calls.some((c) => c[0] === "transcribe")).toBe(true);
  });

  it("要拉起服务时，转写这一步挂上「正在启动 WhisperX 服务」的附注", async () => {
    const fake = fakeHypit();
    const { evidence, templateId, ensure } = await seed(fake);
    let noteWhileStarting: unknown;
    ensure.mockImplementation(async (_ws, _opts, hooks) => {
      hooks?.onStarting?.();
      noteWhileStarting = evidence.evidenceState(templateId).steps.find((s) => s.step === "transcribe")?.detail;
      return "started";
    });
    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    const state = await settle(evidence, templateId);

    expect(noteWhileStarting).toEqual({ note: "正在启动 WhisperX 服务" });
    // 完成后附注被转写结果换掉，不残留
    expect(state.steps.find((s) => s.step === "transcribe")?.detail).not.toEqual({ note: "正在启动 WhisperX 服务" });
  });

  it("服务拉起后真正转写时，「正在启动」附注已撤掉", async () => {
    const fake = fakeHypit();
    const { evidence, templateId, ensure } = await seed(fake);
    ensure.mockImplementation(async (_ws, _opts, hooks) => {
      hooks?.onStarting?.();
      return "started";
    });
    const cli = await import("../hypit/cli.js");
    let detailDuringTranscribe: unknown = "not-called";
    vi.mocked(cli.runHypit).mockImplementation((async (args: readonly string[]) => {
      if (args[0] === "transcribe") {
        detailDuringTranscribe = evidence.evidenceState(templateId).steps.find((s) => s.step === "transcribe")?.detail;
      }
      return fake.impl(args);
    }) as unknown as typeof cli.runHypit);

    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    await settle(evidence, templateId);
    expect(detailDuringTranscribe).toBeUndefined();
  });

  it("拉起失败后重试、服务已在跑：重试期间不残留上一轮的「正在启动」", async () => {
    const fake = fakeHypit();
    const { evidence, templateId, ensure } = await seed(fake);
    const { HypitError } = await import("../hypit/cli.js");
    ensure.mockImplementationOnce(async (_ws, _opts, hooks) => {
      hooks?.onStarting?.();
      throw new HypitError("WHISPERX_NOT_READY", "没起来");
    });
    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    await settle(evidence, templateId);

    let detailOnRetry: unknown = "not-called";
    ensure.mockImplementationOnce(async () => {
      detailOnRetry = evidence.evidenceState(templateId).steps.find((s) => s.step === "transcribe")?.detail;
      return "already-up";
    });
    evidence.retryEvidence(templateId, "transcribe");
    const state = await settle(evidence, templateId);
    expect(detailOnRetry).toBeUndefined();
    expect(state.status).toBe("done");
  });

  it("服务拉不起来：停在转写并带上 hypit 的原文，不去跑 transcribe", async () => {
    const fake = fakeHypit();
    const { evidence, templateId, ensure } = await seed(fake);
    const { HypitError } = await import("../hypit/cli.js");
    // 真实顺序：先挂上「正在启动」，programs up 起不来再抛
    ensure.mockImplementation(async (_ws, _opts, hooks) => {
      hooks?.onStarting?.();
      throw new HypitError(
        "WHISPERX_NOT_READY",
        "本地转写服务没能启动：whisperx · down",
        undefined,
        '{"ready": false}',
      );
    });

    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    const state = await settle(evidence, templateId);

    const step = state.steps.find((s) => s.step === "transcribe");
    expect(step?.status).toBe("failed");
    expect(step?.detail).toBeUndefined();
    expect(step?.errorCode).toBe("WHISPERX_NOT_READY");
    expect(step?.errorMessage).toContain("本地转写服务没能启动");
    expect(step?.errorRaw).toBe('{"ready": false}');
    expect(fake.calls.some((c) => c[0] === "transcribe")).toBe(false);
  });

  it("上传路径就是上传目录本身时拒绝，不把整个目录搬走（复审 #2）", async () => {
    const fake = fakeHypit();
    const { evidence, templateId } = await seed(fake);
    const other = fakeUpload("someone-else.mp4");
    const uploads = path.dirname(other);

    await evidence.startEvidence({ templateId, source: { kind: "file", path: uploads }, language: "zh" });
    const state = await settle(evidence, templateId);

    expect(state.steps.find((s) => s.step === "fetch")?.errorCode).toBe("UPLOAD_OUTSIDE");
    expect(existsSync(other)).toBe(true);
  });

  it("上传目录里的子目录也拒绝：只收文件", async () => {
    const fake = fakeHypit();
    const { evidence, templateId } = await seed(fake);
    const dir = path.join(dataRoot, "uploads", "sub");
    mkdirSync(dir, { recursive: true });

    await evidence.startEvidence({ templateId, source: { kind: "file", path: dir }, language: "zh" });
    const state = await settle(evidence, templateId);

    expect(state.steps.find((s) => s.step === "fetch")?.errorCode).toBe("UPLOAD_OUTSIDE");
    expect(existsSync(dir)).toBe(true);
  });

  it("没有转写结果时 tiles 不带 --transcript", async () => {
    const fake = fakeHypit();
    const { evidence, templateId, workspace } = await seed(fake);
    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    await settle(evidence, templateId);

    // 假的 transcribe 不会真写出 transcript.json，所以 tiles 不该带它
    expect(existsSync(path.join(workspace, "references", "transcript.json"))).toBe(false);
    const tilesCall = fake.calls.find((c) => c[1] === "tiles");
    expect(tilesCall).toBeDefined();
    expect(tilesCall?.includes("--transcript")).toBe(false);
  });

  it("时长超限时先把探测事实存下来再报错——界面要拿得到分辨率", async () => {
    const cli = await import("../hypit/cli.js");
    const { evidence, templateId } = await seed(fakeHypit());
    vi.spyOn(cli, "runHypit").mockImplementation((async (args: readonly string[]) => {
      if (args[1] === "probe") {
        return { json: { duration: 281.2, hasVideo: true, hasAudio: true, width: 360, height: 360, frameRate: 30 } };
      }
      return { json: { ok: true } };
    }) as unknown as typeof cli.runHypit);

    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    const state = await settle(evidence, templateId);

    expect(state.steps.find((s) => s.step === "probe")?.errorCode).toBe("DURATION_TOO_LONG");
    expect(state.probe).toMatchObject({ duration: 281.2, width: 360, height: 360 });
  });

  it("时长上限跟设置走，不是硬编码的 180", async () => {
    const cli = await import("../hypit/cli.js");
    const { evidence, db, templateId } = await seed(fakeHypit());
    db().prepare("UPDATE settings SET reference_max_seconds = 300 WHERE id = 1").run();
    vi.spyOn(cli, "runHypit").mockImplementation((async (args: readonly string[]) => {
      if (args[1] === "probe") return { json: { duration: 281.2, hasVideo: true, hasAudio: true } };
      return { json: { ok: true } };
    }) as unknown as typeof cli.runHypit);

    await evidence.startEvidence({ templateId, source: { kind: "file", path: fakeUpload() }, language: "zh" });
    const state = await settle(evidence, templateId);

    // 281 秒在 300 秒上限下应该放行
    expect(state.steps.find((s) => s.step === "probe")?.status).toBe("done");
  });
});
