import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataRoot: string;
let closeCurrent: (() => void) | undefined;

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-ev-"));
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
});

async function seed() {
  const dbMod = await import("../db/index.js");
  const migrateMod = await import("../db/migrate.js");
  const archive = await import("./archive.js");
  const store = await import("./evidence-store.js");
  const sse = await import("../lib/sse.js");
  closeCurrent = dbMod.closeDb;
  migrateMod.migrate();

  const client = archive.createClient("老王工作室");
  const template = archive.createTemplate(client.id, "足球榜");
  store.ensureSteps(template.id);
  return { store, sse: sse.sseHub, templateId: template.id, db: dbMod.db };
}

describe("evidence-store", () => {
  it("建齐四步 pending，顺序按流水线来而不是数据库返回顺序", async () => {
    const { store, templateId } = await seed();
    expect(store.listSteps(templateId).map((s) => [s.step, s.status])).toEqual([
      ["fetch", "pending"],
      ["probe", "pending"],
      ["transcribe", "pending"],
      ["tiles", "pending"],
    ]);
  });

  it("重复 ensureSteps 不会把已完成的步骤抹回 pending", async () => {
    const { store, templateId } = await seed();
    store.markRunning(templateId, "fetch");
    store.markDone(templateId, "fetch", { kind: "file" });

    store.ensureSteps(templateId);
    expect(store.listSteps(templateId).find((s) => s.step === "fetch")?.status).toBe("done");
  });

  it("记下耗时，且 detail 原样存回来", async () => {
    const { store, templateId } = await seed();
    store.markRunning(templateId, "probe");
    store.markDone(templateId, "probe", { duration: 19.5, hasVideo: true, hasAudio: true });

    const probe = store.listSteps(templateId).find((s) => s.step === "probe");
    expect(probe?.status).toBe("done");
    expect(probe?.durationMs).toBeGreaterThanOrEqual(0);
    expect(probe?.detail).toEqual({ duration: 19.5, hasVideo: true, hasAudio: true });
  });

  /** REQ-002 规则：失败时展示 hypit.cli-error@1 的 code 与 message，不吞错 */
  it("失败原样存 code 与 message", async () => {
    const { store, templateId } = await seed();
    store.markRunning(templateId, "fetch");
    store.markFailed(templateId, "fetch", { code: "CLI_ERROR", message: "yt-dlp could not fetch …404" });

    const fetchStep = store.listSteps(templateId).find((s) => s.step === "fetch");
    expect(fetchStep?.status).toBe("failed");
    expect(fetchStep?.errorCode).toBe("CLI_ERROR");
    expect(fetchStep?.errorMessage).toContain("404");
  });

  it("超时单独一个状态，不跟普通失败混在一起（REQ-002：单项 >10 分钟标超时可重试）", async () => {
    const { store, templateId } = await seed();
    store.markRunning(templateId, "transcribe");
    store.markFailed(templateId, "transcribe", { code: "TIMEOUT", message: "超过 600s 未返回", timedOut: true });

    expect(store.listSteps(templateId).find((s) => s.step === "transcribe")?.status).toBe("timeout");
  });

  it("重跑前清回 pending，旧的探测结果不留着骗人", async () => {
    const { store, templateId } = await seed();
    store.markRunning(templateId, "probe");
    store.markDone(templateId, "probe", { duration: 281 });

    store.resetSteps(templateId);
    const probe = store.listSteps(templateId).find((s) => s.step === "probe");
    expect(probe?.status).toBe("pending");
    expect(probe?.detail).toBeUndefined();
    expect(probe?.durationMs).toBeUndefined();
  });

  it("重新开跑会清掉上一次的错误，界面不该还挂着旧红字", async () => {
    const { store, templateId } = await seed();
    store.markRunning(templateId, "fetch");
    store.markFailed(templateId, "fetch", { code: "CLI_ERROR", message: "404" });

    store.markRunning(templateId, "fetch");
    const fetchStep = store.listSteps(templateId).find((s) => s.step === "fetch");
    expect(fetchStep?.status).toBe("running");
    expect(fetchStep?.errorCode).toBeUndefined();
    expect(fetchStep?.errorMessage).toBeUndefined();
  });

  /** 推给 `template:<id>` 而不是 global：一个模板的进度不该把所有页面都刷一遍 */
  it("每次状态变化推一条 SSE，主题是这个模板自己的", async () => {
    const { store, sse, templateId } = await seed();
    const spy = vi.spyOn(sse, "publish");

    store.markRunning(templateId, "fetch");
    store.markDone(templateId, "fetch");

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[0]).toBe(`template:${templateId}`);
    expect(spy.mock.calls[0]?.[1]).toBe("evidence");
    expect(spy.mock.calls[0]?.[2]).toMatchObject({ templateId, step: "fetch" });
  });

  it("模板删掉时步骤跟着走，不留孤儿", async () => {
    const { store, templateId, db } = await seed();
    store.markDone(templateId, "fetch");
    db().prepare("DELETE FROM templates WHERE id = ?").run(templateId);

    const left = db().prepare("SELECT COUNT(*) AS n FROM evidence_steps").get() as { n: number };
    expect(left.n).toBe(0);
  });
});
