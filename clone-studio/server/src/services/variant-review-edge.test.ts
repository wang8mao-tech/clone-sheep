import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { until, useCloneSandbox } from "./clone-test-kit.js";
import { bootVariants } from "./variant-test-kit.js";
import { inReview, makeImage, sizeOf, upload } from "./variant-review-kit.js";

/** 素材审核的边角（8.2 第一轮审查）：重跑与估价 / 重试出片的竞态、上传文件总会删、打回前告诉会话哪些图是人换的、按实际编码收图 */

useCloneSandbox();

/** 一条估价没过（未解析请求）的变体：状态失败、没有 build */
const BLOCKED_PLAN = {
  format: "hypit.cli-plan@1",
  ok: true,
  providerRequestCount: 1,
  unresolvedRequestCount: 1,
  unsupportedRequestCount: 0,
  providers: [{ request: "r1", capability: "x#y", status: "unresolved" }],
  needs: [],
  preflight: { ok: true, diagnostics: [] },
};

describe("重跑与估价 / 重试出片（M1 / M2）", () => {
  it("正在重新估价时不许重跑；估价结论也不落到没有运行文件的出片单位上", async () => {
    const b = await bootVariants();
    b.setPlan(BLOCKED_PLAN);
    const { id, review, assetId } = await inReview(b);
    await review.replaceAsset(assetId("assets/02-gap.jpg"), upload(b, "g.png", 10, 10));
    review.approveAssets(id);
    await until(() => b.statusOf(id) === "failed", "估价 blocked → 失败");
    let release: (plan: Record<string, unknown>) => void = () => undefined;
    b.setPlan(() => new Promise((resolve) => (release = resolve)));
    const pending = b.estimate.estimateProduction(id);
    expect(() => review.rerunVariant(id)).toThrow(expect.objectContaining({ code: "ESTIMATING" }));
    // 就算有别的路径把它清成了没有运行文件（重跑），估完的结论也不改它的状态
    b.db().prepare("UPDATE productions SET run_path = NULL, status = 'queued' WHERE id = ?").run(id);
    // 估出来是「待确认」（付费能力没有费率 → 估价拿不到）：真套用了就会把它改成待确认花费
    release({
      ...BLOCKED_PLAN,
      unresolvedRequestCount: 0,
      providers: [
        {
          request: "r1",
          capability: "@hypit/seedance@2#generate-video",
          status: "resolved",
          endpoint: "td",
          pricing: { kind: "page", url: "https://x.test" },
        },
      ],
      needs: [{ request: "r1", summary: { fields: { duration: 5 } } }],
    });
    const record = await pending;
    expect(record.decision).toBe("confirm");
    expect(b.statusOf(id)).toBe("queued");
  });

  it("出片失败后重跑、新会话又停下：不能再点重试出片（稿子要重新审）", async () => {
    const b = await bootVariants();
    const { id, review, assetId } = await inReview(b);
    await review.replaceAsset(assetId("assets/02-gap.jpg"), upload(b, "g.png", 10, 10));
    b.setBuild(new Error("渲染炸了"));
    review.approveAssets(id);
    await until(() => b.statusOf(id) === "failed", "出片失败");
    review.rerunVariant(id);
    await until(() => b.calls.length === 2, "重跑开跑");
    const job = b.store.latestJobOf("production", id);
    await b.service.agentScheduler().abort(job?.id as string);
    expect(b.statusOf(id)).toBe("interrupted");
    expect(() => b.build.retryBuild(id)).toThrow(expect.objectContaining({ code: "NOT_RETRYABLE" }));
    // 重跑之后旧稿的估价与出片不再给界面（不然看着像还能重试出片）
    const view = b.variants.presentVariant(b.vstore.findVariant(id) as never);
    expect(view.estimate).toBeNull();
    expect(view.build).toBeNull();
    expect(b.statusOf(id)).toBe("interrupted");
  });
});

describe("替换单张的边角", () => {
  it("素材不存在 / 不在素材待审：上传的文件照样删掉（M3）", async () => {
    const b = await bootVariants();
    const { id, review, assetId } = await inReview(b);
    const first = upload(b, "a.png", 10, 10);
    await expect(review.replaceAsset("nope", first)).rejects.toMatchObject({ status: 404 });
    expect(existsSync(first)).toBe(false);
    await b.variants.cancelVariant(id);
    const second = upload(b, "b.png", 10, 10);
    await expect(review.replaceAsset(assetId("assets/01-a.jpg"), second)).rejects.toMatchObject({
      code: "NOT_REVIEWING",
    });
    expect(existsSync(second)).toBe(false);
  });

  it("按实际编码收图：gif 改名成 .png 也不收（L2）", async () => {
    const b = await bootVariants();
    const { review, assetId } = await inReview(b);
    const gif = path.join(b.workspace, "..", "fake.png");
    const real = path.join(b.workspace, "..", "real.gif");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=10x10", "-frames:v", "1", real]);
    renameSync(real, gif);
    await expect(review.replaceAsset(assetId("assets/01-a.jpg"), gif)).rejects.toMatchObject({
      code: "BAD_FILE_TYPE",
      status: 400,
    });
  });

  it("文件名里有 %d：ffmpeg 不当成序号模板，照样写回原名（L1）", async () => {
    const b = await bootVariants();
    const id = b.submit(["换成手机品牌排行榜"]).variants[0]?.id as string;
    const dir = b.dirOf(id);
    // 造图时也会被展开：先用普通名字生成再改名
    makeImage(path.join(dir, "assets/05-plain.jpg"), 40, 40);
    renameSync(path.join(dir, "assets/05-plain.jpg"), path.join(dir, "assets/05-a%d.jpg"));
    b.writeProducts(id, {
      images: [],
      sources: { assets: [{ file: "assets/05-a%d.jpg", sourceUrl: "https://a.test" }] },
    });
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "asset_review", "进素材待审");
    const review = await import("./variant-review.js");
    const aid = b.vstore.listAssets(id)[0]?.id as string;
    await review.replaceAsset(aid, upload(b, "p.png", 90, 30));
    expect(sizeOf(path.join(dir, "assets/05-a%d.jpg"))).toBe("40,40");
  });

  it("看图：路径跑出变体目录的素材行一律 404", async () => {
    const b = await bootVariants();
    const { id, review } = await inReview(b);
    writeFileSync(path.join(b.workspace, "secret.txt"), "x", "utf8");
    b.db()
      .prepare(
        "INSERT INTO assets (id, production_id, label, file_path, source_url, replaced_by_user, is_gap, created_at) VALUES ('evil', ?, 'x', '../../secret.txt', NULL, 0, 0, '')",
      )
      .run(id);
    expect(() => review.assetFile("evil")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("打回前告诉会话哪些图是人换的（M5）", () => {
  it("替换过一张再打回：USER_ASSETS.json 列着它；没有替换过的就不留这个文件", async () => {
    const b = await bootVariants();
    const { id, dir, review, assetId } = await inReview(b);
    writeFileSync(path.join(dir, "USER_ASSETS.json"), '{"assets":["assets/旧的.jpg"]}', "utf8");
    await review.replaceAsset(assetId("assets/03-c.png"), upload(b, "c.png", 20, 20));
    review.reworkVariant(id, "第一张换成正面照");
    expect(JSON.parse(readFileSync(path.join(dir, "USER_ASSETS.json"), "utf8"))).toEqual({
      assets: ["assets/03-c.png"],
    });
  });

  it("没替换过：打回时清掉旧清单", async () => {
    const b = await bootVariants();
    const { id, dir, review } = await inReview(b);
    writeFileSync(path.join(dir, "USER_ASSETS.json"), '{"assets":["assets/旧的.jpg"]}', "utf8");
    review.reworkVariant(id, "换一批图");
    expect(existsSync(path.join(dir, "USER_ASSETS.json"))).toBe(false);
  });
});
