import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { until, useCloneSandbox } from "./clone-test-kit.js";
import { bootVariants } from "./variant-test-kit.js";
import { inReview, jobCount, makeImage, paidPlan, SEEDANCE, sizeOf, upload } from "./variant-review-kit.js";

/**
 * 素材审核（REQ-005、FLOW-003 步骤 4-6 与分支）：替换单张保持文件名与尺寸（真 ffmpeg）、有缺口不能通过、
 * 通过后交给估价闸门（AC-015 / 017 / 018 / 019）、打回、重跑只清 Agent 的产物。
 */

useCloneSandbox();

describe("审核状态", () => {
  it("素材卡带来源域名、缺口、图片地址；台词全文；有缺口时不能通过并写明原因", async () => {
    const b = await bootVariants();
    const { id, review } = await inReview(b);
    const state = review.reviewState(id);
    expect(state.assets.map((a) => [a.file, a.sourceHost, a.gap, a.replaced])).toEqual([
      ["assets/01-a.jpg", "img.example.com", false, false],
      ["assets/02-gap.jpg", null, true, false],
      ["assets/03-c.png", null, false, false],
    ]);
    expect(state.assets[0]?.imageUrl).toMatch(/^\/api\/assets\/[\w-]+\/file\?v=\d+$/);
    expect(state.script).toContain("第一段");
    expect(state.approveBlocked).toBe("还有 1 个缺口没补，先上传");
    expect(state.reworkBlocked).toBeNull();
    expect(state.batch).toMatchObject({ limitUsd: 15, spentUsd: 0 });
  });
});

describe("替换单张（REQ-005 MUST：保持文件名与尺寸，不重跑 Agent）", () => {
  it("300×200 的 png 换进 100×100 的 jpg：写回原文件名、按原尺寸裁好、标已替换；没有新的 Agent 任务（AC-015）", async () => {
    const b = await bootVariants();
    const { id, dir, review, assetId } = await inReview(b);
    const jobs = jobCount(b);
    const calls = b.calls.length;
    const src = upload(b, "wide.png", 300, 200);
    const view = await review.replaceAsset(assetId("assets/01-a.jpg"), src);
    expect(view).toMatchObject({ file: "assets/01-a.jpg", replaced: true, gap: false, sourceUrl: null });
    expect(sizeOf(path.join(dir, "assets/01-a.jpg"))).toBe("100,100");
    expect(existsSync(src)).toBe(false);
    expect(jobCount(b)).toBe(jobs);
    expect(b.calls.length).toBe(calls);
    expect(b.statusOf(id)).toBe("asset_review");
  });

  it("补缺口：清掉缺口标记，按占位图的尺寸；补完就能通过", async () => {
    const b = await bootVariants();
    const { id, dir, review, assetId } = await inReview(b);
    await review.replaceAsset(assetId("assets/02-gap.jpg"), upload(b, "g.jpg", 50, 400));
    expect(sizeOf(path.join(dir, "assets/02-gap.jpg"))).toBe("100,100");
    expect(review.reviewState(id).approveBlocked).toBeNull();
  });

  it("原图被手动删了：不知道该多大，明确报错，上传文件照样删掉", async () => {
    const b = await bootVariants();
    const { dir, review, assetId } = await inReview(b);
    const { rmSync } = await import("node:fs");
    rmSync(path.join(dir, "assets/02-gap.jpg"));
    const src = upload(b, "g2.png", 30, 30);
    await expect(review.replaceAsset(assetId("assets/02-gap.jpg"), src)).rejects.toMatchObject({
      code: "UNKNOWN_SIZE",
    });
    expect(existsSync(src)).toBe(false);
  });

  it("上传的不是图：400，原图不动，上传文件删掉", async () => {
    const b = await bootVariants();
    const { dir, review, assetId } = await inReview(b);
    const before = readFileSync(path.join(dir, "assets/01-a.jpg"));
    const fake = path.join(b.workspace, "..", "fake.png");
    writeFileSync(fake, "not an image", "utf8");
    await expect(review.replaceAsset(assetId("assets/01-a.jpg"), fake)).rejects.toMatchObject({
      code: "NOT_AN_IMAGE",
      status: 400,
    });
    expect(readFileSync(path.join(dir, "assets/01-a.jpg"))).toEqual(before);
    expect(existsSync(fake)).toBe(false);
    expect(b.vstore.listAssets(dir.split(path.sep).at(-1) as string).every((a) => a.replaced_by_user === 0)).toBe(true);
  });

  it("不在素材待审（已通过、已取消）：不能换", async () => {
    const b = await bootVariants();
    const { id, review, assetId } = await inReview(b);
    await b.variants.cancelVariant(id);
    await expect(review.replaceAsset(assetId("assets/01-a.jpg"), upload(b, "x.png", 10, 10))).rejects.toMatchObject({
      code: "NOT_REVIEWING",
    });
  });

  it("转换期间人点了素材通过：转换完不写回原图、不标已替换，报不在素材待审", async () => {
    const b = await bootVariants();
    const { id, dir, review, assetId } = await inReview(b);
    await review.replaceAsset(assetId("assets/02-gap.jpg"), upload(b, "g.png", 10, 10));
    const tool = await import("../lib/image-tool.js");
    const real = tool.fitImage;
    let started = false;
    let release: () => void = () => undefined;
    vi.spyOn(tool, "fitImage").mockImplementation(async (input, output, size) => {
      started = true;
      await new Promise<void>((resolve) => (release = resolve));
      return real(input, output, size);
    });
    const before = readFileSync(path.join(dir, "assets/01-a.jpg"));
    const pending = review.replaceAsset(assetId("assets/01-a.jpg"), upload(b, "w.png", 30, 30));
    await until(() => started, "开始转换");
    review.approveAssets(id);
    release();
    await expect(pending).rejects.toMatchObject({ code: "NOT_REVIEWING" });
    expect(readFileSync(path.join(dir, "assets/01-a.jpg"))).toEqual(before);
    expect(b.vstore.listAssets(id).find((a) => a.file_path === "assets/01-a.jpg")?.replaced_by_user).toBe(0);
  });

  it("素材不存在：404", async () => {
    const b = await bootVariants();
    const { review } = await inReview(b);
    await expect(review.replaceAsset("nope", upload(b, "y.png", 10, 10))).rejects.toMatchObject({ status: 404 });
  });
});

describe("素材通过 → 估价闸门 → 出片", () => {
  it("有缺口不能通过", async () => {
    const b = await bootVariants();
    const { id, review } = await inReview(b);
    expect(() => review.approveAssets(id)).toThrow(expect.objectContaining({ code: "ASSETS_HAVE_GAPS" }));
    expect(b.statusOf(id)).toBe("asset_review");
  });

  it("补完缺口、替换一张后通过：估价 $0 自动出片到完成，出片用的是变体的运行文件，全程没有新的 Agent 花费（AC-015 / AC-017）", async () => {
    const b = await bootVariants();
    const { id, review, assetId } = await inReview(b);
    await review.replaceAsset(assetId("assets/02-gap.jpg"), upload(b, "g.png", 10, 10));
    const jobs = jobCount(b);
    review.approveAssets(id);
    await until(() => b.statusOf(id) === "done", "出片完成");
    const submit = b.hypitCalls.find((a) => a[0] === "build");
    expect(submit?.[1]).toBe(`productions/${id}/variant.svrun`);
    expect(jobCount(b)).toBe(jobs);
    expect(b.build.latestBuild(id)?.status).toBe("done");
  });

  it("估价 $2.1 超过单条限额：停在待确认花费，确认后才出片（AC-018）", async () => {
    const b = await bootVariants();
    b.rates.upsertRate({ capability: SEEDANCE, unit: "second", usd: 0.42 });
    b.setPlan(paidPlan());
    const { id, review, assetId } = await inReview(b);
    await review.replaceAsset(assetId("assets/02-gap.jpg"), upload(b, "g.png", 10, 10));
    review.approveAssets(id);
    await until(() => b.statusOf(id) === "awaiting_cost_confirm", "待确认花费");
    expect(b.estimate.currentEstimate(id)).toMatchObject({ totalUsd: 2.1, decision: "confirm" });
    expect(b.hypitCalls.some((a) => a[0] === "build")).toBe(false);
    b.estimate.confirmCost(id);
    await until(() => b.statusOf(id) === "done", "确认后出片完成");
  });

  it("批次限额用尽：之后的变体全部停在待确认花费（AC-019）", async () => {
    const b = await bootVariants();
    b.rates.upsertRate({ capability: SEEDANCE, unit: "second", usd: 0.18 });
    b.setPlan(paidPlan());
    // 每条 $0.9，批次限额 $1.5：第一条放行，第二条超批次，第三条跟着停
    const batch = b.submit(["换成手机品牌排行榜", "换成汽车品牌排行榜", "换成相机品牌排行榜"], { budgetUsd: 1.5 });
    const ids = batch.variants.map((v) => v.id);
    const review = await import("./variant-review.js");
    for (const [i, id] of ids.entries()) {
      const dir = b.dirOf(id);
      makeImage(path.join(dir, "assets/01-a.jpg"), 20, 20);
      b.writeProducts(id, {
        images: [],
        sources: { assets: [{ file: "assets/01-a.jpg", sourceUrl: "https://a.test" }] },
      });
      await b.finishCall(i);
      await until(() => b.statusOf(id) === "asset_review", `第 ${i + 1} 条进素材待审`);
    }
    // 第一条卡在渲染里（占着批次的已花）
    b.setWatch(() => new Promise(() => undefined));
    for (const id of ids) {
      review.approveAssets(id);
      await until(() => b.estimate.currentEstimate(id) !== undefined, "估价落库");
    }
    await until(() => b.statusOf(ids[0] as string) === "building", "第一条出片中");
    expect(ids.slice(1).map((id) => b.statusOf(id))).toEqual(["awaiting_cost_confirm", "awaiting_cost_confirm"]);
    expect(b.estimate.currentEstimate(ids[1] as string)?.reasons).toContain("over_batch_limit");
    expect(b.estimate.currentEstimate(ids[2] as string)?.reasons).toContain("batch_halted");
    const list = b.variants.listVariants(b.templateId).batches[0];
    expect(list).toMatchObject({ halted: true, limitUsd: 1.5 });
    expect(list?.spentUsd).toBeCloseTo(0.9, 6);
  });
});
