import { describe, expect, it } from "vitest";
import { assistant, boot } from "./agent-jobs-test-kit.js";

/** 游标契约：Task 5.4 的抽屉照这个写拉取循环，页被截短时一条都不能漏（复审 S1-M7） */

describe("游标契约（Task 5.4 照这个写循环）", () => {
  /**
   * 这条按文件头那段伪码演一遍前端：拉一页、把游标推到 nextSeq、hasNewer 为真就继续。
   * 页会被字节上限截短，所以它同时验了「截短时不会跳过中间那些」——
   * 用 jobLastSeq 当游标的话，这里会漏掉一大段（复审 S1-M7）。
   */
  it("按文件头的循环拉：每条恰好拿到一次，一条不漏一条不重", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const store = await import("../agent/message-store.js");
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    // 每条约 1.5MB，4MB 的预算一页装不下几条，必然触发截短
    const chunk = "z".repeat(1_500_000);
    for (let i = 0; i < 8; i++) calls[0]!.emit(assistant(chunk));
    expect(store.lastSeq(job.id)).toBe(8);

    const seen: number[] = [];
    let cursor = 0;
    let hasNewer = true;
    let rounds = 0;
    while (hasNewer && rounds++ < 20) {
      const res = await a.inject({ url: `/api/agent-jobs/${job.id}/messages?afterSeq=${cursor}` });
      const page = res.json<{ messages: { seq: number }[]; nextSeq: number; hasNewer: boolean }>();
      seen.push(...page.messages.map((m) => m.seq));
      cursor = page.nextSeq;
      hasNewer = page.hasNewer;
    }

    expect(rounds).toBeGreaterThan(1); // 确实被截短过，不是一页拿完
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  }, 30_000);

  it("追平之后再拉：空页，游标原地不动（不倒回开头）", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    for (let i = 0; i < 3; i++) calls[0]!.emit(assistant(`第 ${i}`));

    const res = await a.inject({ url: `/api/agent-jobs/${job.id}/messages?afterSeq=3` });
    const page = res.json<{ messages: unknown[]; nextSeq: number; lastSeq: number; jobLastSeq: number }>();
    expect(page.messages).toEqual([]);
    expect(page.nextSeq).toBe(3); // 原样还回来
    expect(page.lastSeq).toBe(0);
    expect(page.jobLastSeq).toBe(3);
  });

  it("往前翻到头：beforeSeq=0 给空页，不是 400（复审 S1-L3）", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    calls[0]!.emit(assistant("一"));
    const res = await a.inject({ url: `/api/agent-jobs/${job.id}/messages?beforeSeq=0` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ messages: [], hasOlder: false, jobLastSeq: 1 });
  });

  it("首屏可以少要几条（复审 S1-L5）", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    for (let i = 1; i <= 6; i++) calls[0]!.emit(assistant(`第 ${i}`));
    const res = await a.inject({ url: `/api/templates/${template.id}/agent-job?limit=3` });
    const body = res.json<{ messages: { seq: number }[]; hasOlder: boolean }>();
    expect(body.messages.map((m) => m.seq)).toEqual([4, 5, 6]);
    expect(body.hasOlder).toBe(true);
  });

  it("单个任务查询给的是 jobLastSeq（5.4 每次重连拿它对表，复审 S2-M3）", async () => {
    const { app: a, scheduler, calls, template } = await boot();
    const job = scheduler.enqueue({ ownerKind: "template", ownerId: template.id, prompt: "复刻" });
    calls[0]!.emit(assistant("一"));
    const res = await a.inject({ url: `/api/agent-jobs/${job.id}` });
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ jobLastSeq: 1 });
    expect(body).not.toHaveProperty("lastSeq");
  });
});
