import { describe, expect, it } from "vitest";
import { until, useCloneSandbox } from "./clone-test-kit.js";
import { bootVariants } from "./variant-test-kit.js";

/** 变体的「已取消」是作废：之后任何路径都不能再在它上面起 Agent 任务、花钱（8.1 审查 HIGH-1） */

useCloneSandbox();

async function oneVariant() {
  const b = await bootVariants();
  const batch = b.submit(["换成 2026 年手机品牌排行，毒舌风格"]);
  const id = batch.variants[0]?.id as string;
  await until(() => b.calls.length === 1, "会话开跑");
  return { b, id };
}

describe("已取消的变体救不活（8.1 审查 HIGH-1）", () => {
  it("取消后抽屉里点重跑 / 继续：拒绝，不起新会话", async () => {
    const { b, id } = await oneVariant();
    await b.variants.cancelVariant(id);
    const job = b.store.latestJobOf("production", id);
    const scheduler = b.service.agentScheduler();
    expect(() => scheduler.rerun(job?.id as string)).toThrow(expect.objectContaining({ code: "VARIANT_CANCELLED" }));
    b.store.updateJob(job?.id as string, { status: "failed" });
    expect(() => scheduler.continueJob(job?.id as string)).toThrow(
      expect.objectContaining({ code: "VARIANT_CANCELLED" }),
    );
    expect(b.calls.length).toBe(1);
    expect(b.statusOf(id)).toBe("cancelled");
  });

  it("核的过程中取消、核的结论是没过：任务不改判失败（改判了就能继续）", async () => {
    const { b, id } = await oneVariant();
    b.writeProducts(id);
    let release = () => undefined as void;
    b.setCheck(() => new Promise((_, reject) => (release = () => reject(new Error("check 挂了")))));
    await b.finishCall(0);
    await until(() => b.hypitCalls.some((a) => a[0] === "check"), "开始核");
    await b.variants.cancelVariant(id);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(b.store.latestJobOf("production", id)?.status).toBe("done");
    expect(b.statusOf(id)).toBe("cancelled");
  });

  it("抽屉里中止一个还没开跑的任务（记已取消）：变体记中断而不是作废，重跑后照常走到素材待审", async () => {
    const b = await bootVariants();
    const ids = b.submit(["换成手机品牌排行榜", "换成汽车品牌排行榜", "换成相机品牌排行榜"]).variants.map((v) => v.id);
    await until(() => b.calls.length === 2, "两个会话开跑");
    const third = ids[2] as string;
    const job = b.store.latestJobOf("production", third);
    await b.service.agentScheduler().abort(job?.id as string);
    expect(b.store.latestJobOf("production", third)?.status).toBe("cancelled");
    expect(b.statusOf(third)).toBe("interrupted");
    b.service.agentScheduler().rerun(job?.id as string);
    await b.finishCall(0);
    await until(() => b.calls.length === 3, "重跑的会话开跑");
    b.writeProducts(third);
    await b.finishCall(2);
    await until(() => b.statusOf(third) === "asset_review", "进素材待审");
  });

  it("已交给出片流水线（有运行文件路径）：不许再起 Agent 任务", async () => {
    const { b, id } = await oneVariant();
    b.writeProducts(id);
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "asset_review", "进素材待审");
    b.db().prepare("UPDATE productions SET run_path = 'x.svrun', status = 'queued' WHERE id = ?").run(id);
    const job = b.store.latestJobOf("production", id);
    expect(() => b.service.agentScheduler().rework(job?.id as string, "改一下")).toThrow(
      expect.objectContaining({ code: "VARIANT_IN_PIPELINE" }),
    );
  });
});
