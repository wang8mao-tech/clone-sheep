import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataRoot: string;
let closeDb: (() => void) | undefined;

async function load() {
  const dbMod = await import("../db/index.js");
  const { migrate } = await import("../db/migrate.js");
  const store = await import("./message-store.js");
  closeDb = dbMod.closeDb;
  migrate();
  dbMod
    .db()
    .prepare(
      "INSERT INTO agent_jobs (id, owner_kind, owner_id, status, created_at) VALUES ('j1', 'template', 't1', 'running', ?)",
    )
    .run(new Date().toISOString());
  return { ...store, db: dbMod.db };
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "cs-msg-"));
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
});

afterEach(() => {
  closeDb?.();
  closeDb = undefined;
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CLONE_STUDIO_DATA_ROOT;
});

const assistant = (text: string) =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as unknown as SDKMessage;

describe("agent_messages 落库与重放", () => {
  it("按 seq 递增落库，原文不截断，role 只给助手与用户消息", async () => {
    const m = await load();
    const long = "x".repeat(50_000);
    m.appendMessage("j1", { type: "system", subtype: "init", session_id: "s-1" } as unknown as SDKMessage);
    m.appendMessage("j1", assistant(long));

    const page = m.listMessages("j1");
    expect(page.messages.map((r) => [r.seq, r.type, r.role])).toEqual([
      [1, "system", null],
      [2, "assistant", "assistant"],
    ]);
    // 喂给抽屉的是原文：长输出由前端折叠，不在这里截
    expect(page.messages[1]!.payload).toMatchObject({ message: { content: [{ text: long }] } });
    expect(page).toMatchObject({ hasOlder: false, hasNewer: false, firstSeq: 1, lastSeq: 2 });
  });

  it("拦截记录和消息在同一条时间线上（抽屉的琥珀竖线）", async () => {
    const m = await load();
    m.appendMessage("j1", assistant("我先跑一下 build"));
    m.appendIntercept("j1", {
      rule: "hypit-command",
      reason: "已拦截：出片由宿主负责",
      detail: "hypit build a.svrun",
      tool: "Bash",
    });
    const page = m.listMessages("j1");
    expect(page.messages.map((r) => r.type)).toEqual(["assistant", m.INTERCEPT_TYPE]);
    expect(page.messages[1]!.payload).toMatchObject({ rule: "hypit-command", tool: "Bash" });
  });

  it("刷新后按 afterSeq 续上，不重复给已经拿到的（AC-009）", async () => {
    const m = await load();
    for (const text of ["一", "二", "三"]) m.appendMessage("j1", assistant(text));
    expect(m.lastSeq("j1")).toBe(3);
    expect(m.listMessages("j1", 2).messages.map((r) => r.seq)).toEqual([3]);
    expect(m.listMessages("j1", 3).messages).toEqual([]);
  });

  it("条数超一页：hasMore 为真，按 lastSeq 接着拉，不会悄悄少一段", async () => {
    const m = await load();
    for (let i = 0; i < 5; i++) m.appendMessage("j1", assistant(`第 ${i}`));
    const first = m.listMessages("j1", 0, 2);
    expect(first.messages.map((r) => r.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ hasNewer: true, hasOlder: false });

    const second = m.listMessages("j1", first.lastSeq, 2);
    expect(second.messages.map((r) => r.seq)).toEqual([3, 4]);
    const third = m.listMessages("j1", second.lastSeq, 2);
    expect(third).toMatchObject({ hasNewer: false, lastSeq: 5 });
  });

  it("单页字节数超预算：截断并说明还有，不让一次刷新申请几百 MB", async () => {
    const m = await load();
    const huge = "y".repeat(m.PAGE_BYTE_BUDGET / 2);
    for (let i = 0; i < 4; i++) m.appendMessage("j1", assistant(huge));

    const page = m.listMessages("j1", 0, 500);
    expect(page.messages.length).toBeLessThan(4);
    expect(page.hasNewer).toBe(true);
    // 少的那部分接着拉得到
    expect(m.listMessages("j1", page.lastSeq, 500).messages.length).toBeGreaterThan(0);
  });

  it("抽屉一打开看的是末尾那一页，不是三小时前的开头", async () => {
    const m = await load();
    for (let i = 1; i <= 6; i++) m.appendMessage("j1", assistant(`第 ${i}`));
    const tail = m.listRecentMessages("j1", 2);
    expect(tail.messages.map((r) => r.seq)).toEqual([5, 6]);
    expect(tail).toMatchObject({ hasOlder: true, hasNewer: false, firstSeq: 5, lastSeq: 6 });

    // 全部都在一页里时不谎报还有更多
    expect(m.listRecentMessages("j1", 50)).toMatchObject({ hasOlder: false, hasNewer: false, firstSeq: 1, lastSeq: 6 });
  });

  it("尾页超字节预算时丢掉的是更旧的那些，最后一条一定在页里（复审 S1-M1）", async () => {
    const m = await load();
    const huge = "y".repeat(m.PAGE_BYTE_BUDGET / 2);
    for (let i = 0; i < 3; i++) m.appendMessage("j1", assistant(huge));
    m.appendMessage("j1", assistant("最后一条：result"));

    const tail = m.listRecentMessages("j1");
    // 最后一条必须在：它通常就是 result，丢了抽屉会一直显示成没跑完
    expect(tail.lastSeq).toBe(4);
    expect(tail.messages.at(-1)!.payload).toMatchObject({ message: { content: [{ text: "最后一条：result" }] } });
    expect(tail).toMatchObject({ hasNewer: false, hasOlder: true });
  });

  it("往前翻：beforeSeq 拿它之前的一页，两个方向各自说明还有没有", async () => {
    const m = await load();
    for (let i = 1; i <= 6; i++) m.appendMessage("j1", assistant(`第 ${i}`));
    const tail = m.listRecentMessages("j1", 2);
    expect(tail.messages.map((r) => r.seq)).toEqual([5, 6]);

    const older = m.listMessagesBefore("j1", tail.firstSeq, 2);
    expect(older.messages.map((r) => r.seq)).toEqual([3, 4]);
    expect(older).toMatchObject({ hasOlder: true, hasNewer: true });

    const oldest = m.listMessagesBefore("j1", older.firstSeq, 2);
    expect(oldest.messages.map((r) => r.seq)).toEqual([1, 2]);
    expect(oldest.hasOlder).toBe(false);
  });

  it("任务被删掉时消息跟着删（外键级联）", async () => {
    const m = await load();
    m.appendMessage("j1", assistant("x"));
    m.db().prepare("DELETE FROM agent_jobs WHERE id = 'j1'").run();
    expect(m.listMessages("j1").messages).toEqual([]);
  });
});
