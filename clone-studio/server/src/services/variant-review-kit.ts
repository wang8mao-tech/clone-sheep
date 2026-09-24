import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { until } from "./clone-test-kit.js";
import type { BootedVariants } from "./variant-test-kit.js";

/** 素材审核测试共用：付费 plan、真 ffmpeg 造图 / 读尺寸、把一条变体送进素材待审、上传文件 */

export const SEEDANCE = "@hypit/seedance@2#generate-video";

/** 一条生视频请求、时长 5 秒的 plan：费率按秒给就能凑出想要的估价 */
export function paidPlan() {
  return {
    format: "hypit.cli-plan@1",
    ok: true,
    providerRequestCount: 1,
    unresolvedRequestCount: 0,
    unsupportedRequestCount: 0,
    providers: [
      {
        request: "r1",
        capability: SEEDANCE,
        status: "resolved",
        endpoint: "tokendance.default",
        pricing: { kind: "page", url: "https://tokendance.space/models" },
      },
    ],
    needs: [{ request: "r1", summary: { fields: { duration: 5 } } }],
    preflight: { ok: true, diagnostics: [] },
  };
}

export function makeImage(file: string, width: number, height: number, color = "red"): void {
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${width}x${height}`,
    "-frames:v",
    "1",
    file,
  ]);
}

export function sizeOf(file: string): string {
  return execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], {
    encoding: "utf8",
  }).trim();
}

/** 一条变体进素材待审：01 有来源（100×100 jpg）、02 缺口（占位图 100×100）、03 无来源 png */
export async function inReview(b: BootedVariants, brief = "换成手机品牌排行榜", call = 0) {
  const id = b.submit([brief]).variants[0]?.id as string;
  const dir = b.dirOf(id);
  makeImage(path.join(dir, "assets/01-a.jpg"), 100, 100);
  makeImage(path.join(dir, "assets/02-gap.jpg"), 100, 100, "gray");
  makeImage(path.join(dir, "assets/03-c.png"), 80, 60, "blue");
  b.writeProducts(id, {
    images: [],
    sources: {
      assets: [
        { file: "assets/01-a.jpg", label: "A", sourceUrl: "https://img.example.com/a?x=1" },
        { file: "assets/02-gap.jpg", label: "缺口", gap: true, width: 100, height: 100 },
        { file: "assets/03-c.png", label: "C", sourceUrl: null },
      ],
    },
  });
  await b.finishCall(call);
  await until(() => b.statusOf(id) === "asset_review", "进素材待审");
  const review = await import("./variant-review.js");
  const assetId = (file: string) => b.vstore.listAssets(id).find((a) => a.file_path === file)?.id as string;
  return { id, dir, review, assetId };
}

export function upload(b: BootedVariants, name: string, width: number, height: number, color = "green"): string {
  const file = path.join(b.workspace, "..", `upload-${name}`);
  makeImage(file, width, height, color);
  return file;
}

export const jobCount = (b: BootedVariants) =>
  (b.db().prepare("SELECT COUNT(*) AS n FROM agent_jobs WHERE owner_kind = 'production'").get() as { n: number }).n;
