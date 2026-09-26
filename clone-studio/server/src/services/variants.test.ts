import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { until, useCloneSandbox } from "./clone-test-kit.js";
import { bootVariants, sonnetProfile } from "./variant-test-kit.js";

/** 批量提交与变体队列（REQ-005、FLOW-003 步骤 1-2、AC-014、AC-016） */

useCloneSandbox();

const briefs = (n: number) => Array.from({ length: n }, (_, i) => `换成第 ${i + 1} 个品牌的排行榜`);

function counts(b: Awaited<ReturnType<typeof bootVariants>>) {
  return {
    batches: (b.db().prepare("SELECT COUNT(*) AS n FROM batches").get() as { n: number }).n,
    variants: (b.db().prepare("SELECT COUNT(*) AS n FROM productions WHERE kind = 'variant'").get() as { n: number }).n,
    jobs: (
      b.db().prepare("SELECT COUNT(*) AS n FROM agent_jobs WHERE owner_kind = 'production'").get() as { n: number }
    ).n,
  };
}

describe("提交", () => {
  it("提交 5 条：5 条变体、一个批次，每条复制了模板原稿；同时写稿的只有 2 条（AC-014）", async () => {
    const b = await bootVariants();
    const batch = b.submit(briefs(5), { note: "毒舌风格", targetLanguage: "en" });
    expect(batch.variants).toHaveLength(5);
    expect(counts(b)).toEqual({ batches: 1, variants: 5, jobs: 5 });
    for (const v of batch.variants) {
      expect(readFileSync(path.join(b.dirOf(v.id), "reference.svrun"), "utf8")).toBe("# reference.svrun\n");
      expect(existsSync(path.join(b.dirOf(v.id), "assets"))).toBe(true);
    }
    await until(() => b.calls.length === 2, "两个会话开跑");
    await until(() => batch.variants.filter((v) => b.statusOf(v.id) === "agent_running").length === 2, "两条在写稿");
    expect(batch.variants.filter((v) => b.statusOf(v.id) === "queued")).toHaveLength(3);
    // 结束一条，第三条才起来
    await b.finishCall(0);
    await until(() => b.calls.length === 3, "第三个会话开跑");
    expect(batch.variants.filter((v) => b.statusOf(v.id) === "agent_running")).toHaveLength(2);
  });

  it("变体会话在它自己的目录里跑，提示带 brief、目标语言、批次备注与交付格式", async () => {
    const b = await bootVariants();
    const batch = b.submit(["换成 2026 年手机品牌排行，毒舌风格"], { note: "片尾加关注引导", targetLanguage: "en" });
    await until(() => b.calls.length === 1, "会话开跑");
    const input = b.calls[0]?.input;
    expect(input?.workspace).toBe(b.dirOf(batch.variants[0]?.id as string));
    expect(input?.prompt).toContain("换成 2026 年手机品牌排行，毒舌风格");
    expect(input?.prompt).toContain("台词与屏幕文字用这个语言：en");
    expect(input?.prompt).toContain("片尾加关注引导");
    expect(input?.prompt).toContain("SOURCES.json");
    expect(input?.prompt).toContain('"gap": true');
    expect(input?.prompt).toContain("SCRIPT.md");
  });

  it("模板没记语言（老数据）：提示里写「和模板原片相同的语言」，不塞占位词", async () => {
    const b = await bootVariants();
    b.db().prepare("UPDATE templates SET language = NULL WHERE id = ?").run(b.templateId);
    b.submit(["换成汽车品牌排行榜"]);
    await until(() => b.calls.length === 1, "会话开跑");
    expect(b.calls[0]?.input.prompt).toContain("台词与屏幕文字用这个语言：和模板原片相同的语言");
  });

  it("没指定语言用模板的语言；选的档案指定了模型就带给会话", async () => {
    const b = await bootVariants();
    b.submit(["换成汽车品牌排行榜"], { profileId: await sonnetProfile() });
    await until(() => b.calls.length === 1, "会话开跑");
    expect(b.calls[0]?.input.prompt).toContain("台词与屏幕文字用这个语言：zh");
    expect(b.calls[0]?.input.model).toBe("claude-sonnet-5");
  });

  it("21 条整批拒绝，不建批次、不建变体、不起任务、不留目录（AC-016）", async () => {
    const b = await bootVariants();
    expect(() => b.submit(briefs(21))).toThrow(expect.objectContaining({ code: "BRIEFS_TOO_MANY", status: 400 }));
    expect(counts(b)).toEqual({ batches: 0, variants: 0, jobs: 0 });
    expect(readdirSync(path.join(b.workspace, "productions"))).toEqual([]);
  });

  it("有一行不合格：整批拒绝，逐行明细带回去", async () => {
    const b = await bootVariants();
    let error: unknown;
    try {
      b.submit(["换成手机品牌排行", "太短", "x".repeat(501)]);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      code: "BRIEFS_BAD_LINES",
      detail: {
        count: 3,
        lines: [
          { line: 2, problem: "too_short" },
          { line: 3, problem: "too_long" },
        ],
      },
    });
    expect(counts(b).variants).toBe(0);
  });

  it("设置里的条数上限调大了也封顶 20（Spec 定死）；调小了按小的", async () => {
    const b = await bootVariants();
    b.db().prepare("UPDATE settings SET batch_max_items = 50").run();
    expect(() => b.submit(briefs(21))).toThrow(expect.objectContaining({ code: "BRIEFS_TOO_MANY" }));
    b.db().prepare("UPDATE settings SET batch_max_items = 2").run();
    expect(() => b.submit(briefs(3))).toThrow(expect.objectContaining({ code: "BRIEFS_TOO_MANY" }));
    expect(counts(b).variants).toBe(0);
  });

  it("模板没通过验货：拒绝", async () => {
    const b = await bootVariants();
    b.db().prepare("UPDATE templates SET status = 'awaiting_review' WHERE id = ?").run(b.templateId);
    expect(() => b.submit(briefs(1))).toThrow(expect.objectContaining({ code: "NOT_APPROVED" }));
    expect(counts(b).variants).toBe(0);
  });

  it("不存在的档案、超范围的批次限额、超长备注：拒绝", async () => {
    const b = await bootVariants();
    expect(() => b.submit(briefs(1), { profileId: "gpt-5" })).toThrow(
      expect.objectContaining({ code: "PROFILE_NOT_FOUND" }),
    );
    expect(() => b.submit(briefs(1), { budgetUsd: 1 })).toThrow(expect.objectContaining({ code: "INVALID_BUDGET" }));
    expect(() => b.submit(briefs(1), { budgetUsd: 1001 })).toThrow(expect.objectContaining({ code: "INVALID_BUDGET" }));
    expect(() => b.submit(briefs(1), { note: "注".repeat(1001) })).toThrow(
      expect.objectContaining({ code: "INVALID_NOTE" }),
    );
    expect(counts(b).variants).toBe(0);
  });

  it("模板目录里没有原稿：整批作罢，不留下半截目录", async () => {
    const b = await bootVariants();
    const { rmSync } = await import("node:fs");
    rmSync(path.join(b.workspace, "reference.svrun"));
    expect(() => b.submit(briefs(2))).toThrow(expect.objectContaining({ code: "COPY_FAILED" }));
    expect(counts(b).variants).toBe(0);
    expect(readdirSync(path.join(b.workspace, "productions"))).toEqual([]);
  });

  it("批次限额默认取设置；给了就按给的；同一批的变体按提交顺序错开时间（批次闸门靠它分先后）", async () => {
    const b = await bootVariants();
    const first = b.submit(briefs(3));
    expect(first.limitUsd).toBe(15);
    const second = b.submit(briefs(1), { budgetUsd: 4 });
    expect(second.limitUsd).toBe(4);
    const times = first.variants.map((v) => v.createdAt);
    expect(new Set(times).size).toBe(3);
    expect([...times].sort()).toEqual(times);
  });
});

describe("队列", () => {
  it("按批次分组、新批次在前；每条带任务与状态，素材待审 / 待确认花费标需要我处理", async () => {
    const b = await bootVariants();
    const older = b.submit(briefs(2));
    const newer = b.submit(briefs(1));
    b.db().prepare("UPDATE productions SET status = 'awaiting_cost_confirm' WHERE id = ?").run(older.variants[1]?.id);
    const list = b.variants.listVariants(b.templateId);
    expect(list.batches.map((x) => x.id)).toEqual([newer.id, older.id]);
    const olderView = list.batches[1];
    expect(olderView?.variants.map((v) => v.needsMe)).toEqual([false, true]);
    expect(olderView?.variants[0]?.agent?.ownerKind).toBe("production");
    expect(olderView?.spentUsd).toBe(0);
  });
});

describe("取消", () => {
  it("排队中的、写稿中的都能取消：任务取消、变体记已取消，腾出的名额给下一条", async () => {
    const b = await bootVariants();
    const batch = b.submit(briefs(3));
    await until(() => b.calls.length === 2, "两个会话开跑");
    const [a, , c] = batch.variants.map((v) => v.id) as [string, string, string];
    await b.variants.cancelVariant(c);
    expect(b.statusOf(c)).toBe("cancelled");
    expect(b.store.latestJobOf("production", c)?.status).toBe("cancelled");
    await b.variants.cancelVariant(a);
    expect(b.statusOf(a)).toBe("cancelled");
    expect(b.store.latestJobOf("production", a)?.status).toBe("cancelled");
    // 取消了的不能再取消
    await expect(b.variants.cancelVariant(a)).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });
  });

  it("素材待审、待确认花费的也能取消", async () => {
    const b = await bootVariants();
    const batch = b.submit(briefs(1));
    const id = batch.variants[0]?.id as string;
    b.writeProducts(id);
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "asset_review", "进素材待审");
    await b.variants.cancelVariant(id);
    expect(b.statusOf(id)).toBe("cancelled");
  });

  it("渲染中取消：hypit 取消那条 build，执行器收尾后变体仍是已取消（不回到失败）", async () => {
    const b = await bootVariants();
    const id = b.submit(briefs(1)).variants[0]?.id as string;
    b.writeProducts(id);
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "asset_review", "进素材待审");
    b.setWatch(
      (options) =>
        new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    b.db()
      .prepare("UPDATE productions SET run_path = ?, status = 'queued' WHERE id = ?")
      .run(b.files.variantRunPath(id), id);
    await b.estimate.estimateProduction(id);
    await until(() => b.statusOf(id) === "building", "开始出片");
    await until(() => b.cancelled.length === 0 && b.hypitCalls.some((a) => a[0] === "status"), "跟进度");
    await b.variants.cancelVariant(id);
    await until(() => b.build.latestBuild(id)?.status === "cancelled", "build 记已取消");
    expect(b.cancelled).toEqual(["bld_test_0001"]);
    expect(b.statusOf(id)).toBe("cancelled");
  });

  it("渲染中已被作废的出片单位：出片收尾（取消 / 失败）不把它改回失败", async () => {
    const b = await bootVariants();
    const id = b.submit(briefs(1)).variants[0]?.id as string;
    b.writeProducts(id);
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "asset_review", "进素材待审");
    b.setWatch(
      (options) =>
        new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    b.db()
      .prepare("UPDATE productions SET run_path = ?, status = 'queued' WHERE id = ?")
      .run(b.files.variantRunPath(id), id);
    await b.estimate.estimateProduction(id);
    await until(() => b.hypitCalls.some((a) => a[0] === "status"), "跟进度");
    b.db().prepare("UPDATE productions SET status = 'cancelled' WHERE id = ?").run(id);
    await b.build.cancelBuild(id);
    await until(() => b.build.latestBuild(id)?.status === "cancelled", "build 记已取消");
    expect(b.statusOf(id)).toBe("cancelled");
  });

  it("不存在的变体：404", async () => {
    const b = await bootVariants();
    await expect(b.variants.cancelVariant("nope")).rejects.toMatchObject({ code: "VARIANT_NOT_FOUND", status: 404 });
  });
});

describe("模板与变体互斥（Task 5.2 复审 S2-L7）", () => {
  it("变体任务没结束：模板不能继续 / 重跑，也不能换参考视频", async () => {
    const b = await bootVariants();
    // 模板有一个已中断的复刻任务，可以继续 / 重跑
    const tjob = b.store.createJob({ ownerKind: "template", ownerId: b.templateId, prompt: "复刻" });
    b.store.updateJob(tjob.id, { status: "interrupted" });
    b.submit(briefs(1));
    const scheduler = b.service.agentScheduler();
    expect(() => scheduler.continueJob(tjob.id)).toThrow(expect.objectContaining({ code: "VARIANTS_ACTIVE" }));
    expect(() => scheduler.rerun(tjob.id)).toThrow(expect.objectContaining({ code: "VARIANTS_ACTIVE" }));
    await expect(
      b.evidence.startEvidence({
        templateId: b.templateId,
        source: { kind: "url", url: "https://x.test/v" },
        language: "zh",
      }),
    ).rejects.toMatchObject({ code: "VARIANTS_ACTIVE" });
  });

  it("变体都结束了：模板的继续照常", async () => {
    const b = await bootVariants();
    const tjob = b.store.createJob({ ownerKind: "template", ownerId: b.templateId, prompt: "复刻" });
    b.store.updateJob(tjob.id, { status: "interrupted" });
    const batch = b.submit(briefs(1));
    await b.variants.cancelVariant(batch.variants[0]?.id as string);
    expect(b.service.agentScheduler().continueJob(tjob.id).status).not.toBe("interrupted");
  });
});
