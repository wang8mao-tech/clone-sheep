import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { until, useCloneSandbox } from "./clone-test-kit.js";
import { bootVariants } from "./variant-test-kit.js";
import { inReview, makeImage, upload } from "./variant-review-kit.js";

/** 素材审核的打回与重跑（FLOW-003 分支）：意见 resume 该变体会话；重跑只清 Agent 的产物（Task 5.2 复审 S1-M4） */

useCloneSandbox();

describe("打回与重跑", () => {
  it("打回：意见 resume 该变体的会话，变体回到 Agent 这一段；再次完成重新核、再进素材待审", async () => {
    const b = await bootVariants();
    const { id, review } = await inReview(b);
    expect(() => review.reworkVariant(id, "   ")).toThrow(expect.objectContaining({ code: "INVALID_NOTE" }));
    expect(() => review.reworkVariant(id, "字".repeat(2001))).toThrow(
      expect.objectContaining({ code: "INVALID_NOTE" }),
    );
    review.reworkVariant(id, "  第 3 张换成正面照  ");
    await until(() => b.calls.length === 2, "打回开跑");
    const input = b.calls[1]?.input;
    expect(input?.resume).toBe(`s-${id}-0`);
    expect(input?.prompt).toContain("素材审核打回意见：\n第 3 张换成正面照");
    await until(() => b.statusOf(id) === "agent_running", "回到写稿");
    await b.finishCall(1);
    await until(() => b.statusOf(id) === "asset_review", "再进素材待审");
  });

  it("不在素材待审不能打回", async () => {
    const b = await bootVariants();
    const { id, review } = await inReview(b);
    await b.variants.cancelVariant(id);
    expect(() => review.reworkVariant(id, "改一下")).toThrow(expect.objectContaining({ code: "NOT_REVIEWING" }));
  });

  it("出片失败后重跑：清稿子与 Agent 的图，保留用户换过的；运行文件路径清掉；按原提示与模型开新会话", async () => {
    const b = await bootVariants();
    const id = b.submit(["换成手机品牌排行榜"], { modelId: "claude-sonnet-5" }).variants[0]?.id as string;
    const dir = b.dirOf(id);
    makeImage(path.join(dir, "assets/01-a.jpg"), 20, 20);
    makeImage(path.join(dir, "assets/02-b.jpg"), 20, 20);
    b.writeProducts(id, {
      images: [],
      sources: {
        assets: [
          { file: "assets/01-a.jpg", sourceUrl: "https://a" },
          { file: "assets/02-b.jpg", sourceUrl: "https://b" },
        ],
      },
    });
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "asset_review", "进素材待审");
    const review = await import("./variant-review.js");
    const b2 = b.vstore.listAssets(id).find((a) => a.file_path === "assets/02-b.jpg")?.id as string;
    await review.replaceAsset(b2, upload(b, "u.png", 30, 30));
    b.setBuild(new Error("渲染炸了"));
    review.approveAssets(id);
    await until(() => b.statusOf(id) === "failed", "出片失败");
    const view = review.rerunVariant(id);
    // 新会话立刻就开跑了：排队或写稿中都对
    expect(["queued", "agent_running"]).toContain(view.status);
    expect(readFileSync(path.join(dir, "reference.svrun"), "utf8")).toBe("# reference.svrun\n");
    expect(existsSync(path.join(dir, "assets/01-a.jpg"))).toBe(false);
    expect(existsSync(path.join(dir, "assets/02-b.jpg"))).toBe(true);
    expect(existsSync(path.join(dir, "variant.svrun"))).toBe(false);
    expect(b.vstore.listAssets(id).map((a) => a.file_path)).toEqual(["assets/02-b.jpg"]);
    expect(
      (b.db().prepare("SELECT run_path FROM productions WHERE id = ?").get(id) as { run_path: string | null }).run_path,
    ).toBeNull();
    await until(() => b.calls.length === 2, "新会话开跑");
    expect(b.calls[1]?.input.model).toBe("claude-sonnet-5");
    expect(b.calls[1]?.input.resume).toBeUndefined();
  });

  it("重跑的前提：在跑的不行、已完成 / 已取消的不行", async () => {
    const b = await bootVariants();
    const id = b.submit(["换成手机品牌排行榜"]).variants[0]?.id as string;
    await until(() => b.calls.length === 1, "会话开跑");
    const review = await import("./variant-review.js");
    expect(() => review.rerunVariant(id)).toThrow(expect.objectContaining({ code: "NOT_RERUNNABLE" }));
    await b.variants.cancelVariant(id);
    expect(() => review.rerunVariant(id)).toThrow(expect.objectContaining({ code: "NOT_RERUNNABLE" }));
  });
});
