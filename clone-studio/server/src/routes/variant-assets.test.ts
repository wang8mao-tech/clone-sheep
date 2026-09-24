import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { until, useCloneSandbox } from "../services/clone-test-kit.js";
import { bootVariants, type BootedVariants } from "../services/variant-test-kit.js";

/** 素材审核接口：审核状态、素材图、替换上传（类型 / 大小 / 不是图）、通过、打回、重跑 */

useCloneSandbox();

async function app(maxImageBytes?: number) {
  const Fastify = (await import("fastify")).default;
  const { variantAssetRoutes } = await import("./variant-assets.js");
  const server = Fastify();
  await server.register(variantAssetRoutes, maxImageBytes ? { maxImageBytes } : {});
  return server;
}

function makeImage(file: string, width: number, height: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=red:s=${width}x${height}`,
    "-frames:v",
    "1",
    file,
  ]);
}

/** 手拼 multipart 体（同 media-test-kit；那个文件在顶层挂了自己的收尾钩子，不能混用） */
function multipart(filename: string, content: Buffer, extra = 0): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----cs${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (let i = 0; i < extra; i += 1) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="f${i}"\r\n\r\nx\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function reviewing(b: BootedVariants) {
  const id = b.submit(["换成手机品牌排行榜"]).variants[0]?.id as string;
  const dir = b.dirOf(id);
  makeImage(path.join(dir, "assets/01-a.jpg"), 64, 64);
  makeImage(path.join(dir, "assets/02-gap.png"), 64, 64);
  b.writeProducts(id, {
    images: [],
    sources: {
      assets: [
        { file: "assets/01-a.jpg", label: "A", sourceUrl: "https://a.test/1" },
        { file: "assets/02-gap.png", label: "缺口", gap: true },
      ],
    },
  });
  await b.finishCall(0);
  await until(() => b.statusOf(id) === "asset_review", "进素材待审");
  const assets = b.vstore.listAssets(id);
  return { id, dir, a: assets[0]?.id as string, gap: assets[1]?.id as string };
}

function png(b: BootedVariants, w: number, h: number): Buffer {
  const file = path.join(b.workspace, "..", `up-${randomUUID()}.png`);
  makeImage(file, w, h);
  return readFileSync(file);
}

describe("审核状态与素材图", () => {
  it("GET /api/variants/:id/review 给素材与台词；图片按扩展名给类型；不存在 404", async () => {
    const b = await bootVariants();
    const { id, a } = await reviewing(b);
    const server = await app();
    const res = await server.inject({ url: `/api/variants/${id}/review` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      approveBlocked: "还有 1 个缺口没补，先上传",
      assets: [{ sourceHost: "a.test" }, { gap: true }],
    });
    const img = await server.inject({ url: `/api/assets/${a}/file` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/jpeg");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect((await server.inject({ url: "/api/assets/nope/file" })).statusCode).toBe(404);
    expect((await server.inject({ url: "/api/variants/nope/review" })).statusCode).toBe(404);
    await server.close();
  });
});

describe("POST /api/assets/:id/replace", () => {
  it("收 png：按原尺寸写回，标已替换，缺口清掉后能通过", async () => {
    const b = await bootVariants();
    const { id, gap } = await reviewing(b);
    const server = await app();
    const body = multipart("new.png", png(b, 200, 50));
    const res = await server.inject({ method: "POST", url: `/api/assets/${gap}/replace`, ...body });
    expect(res.statusCode).toBe(200);
    expect(res.json().asset).toMatchObject({ replaced: true, gap: false });
    const approve = await server.inject({ method: "POST", url: `/api/variants/${id}/approve` });
    expect(approve.statusCode).toBe(200);
    await server.close();
  });

  it("不在素材待审：先判再收，409 且不落任何上传文件", async () => {
    const b = await bootVariants();
    const { id, a } = await reviewing(b);
    await b.variants.cancelVariant(id);
    const server = await app();
    const { readdirSync, existsSync } = await import("node:fs");
    const uploads = path.join(b.workspace, "..", "..", "..", "..", "uploads");
    const before = existsSync(uploads) ? readdirSync(uploads).length : 0;
    const res = await server.inject({
      method: "POST",
      url: `/api/assets/${a}/replace`,
      ...multipart("x.png", png(b, 20, 20)),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NOT_REVIEWING");
    expect(existsSync(uploads) ? readdirSync(uploads).length : 0).toBe(before);
    await server.close();
  });

  it("类型不对 400；超过上限 413；不是图 400；没有文件 400", async () => {
    const b = await bootVariants();
    const { a } = await reviewing(b);
    const server = await app(1024);
    const bad = await server.inject({
      method: "POST",
      url: `/api/assets/${a}/replace`,
      ...multipart("x.gif", Buffer.from("GIF89a")),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("BAD_FILE_TYPE");
    const big = await server.inject({
      method: "POST",
      url: `/api/assets/${a}/replace`,
      ...multipart("x.png", Buffer.alloc(4096, 1)),
    });
    expect(big.statusCode).toBe(413);
    const fake = await server.inject({
      method: "POST",
      url: `/api/assets/${a}/replace`,
      ...multipart("x.png", Buffer.from("nope")),
    });
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error.code).toBe("NOT_AN_IMAGE");
    const boundary = "----empty";
    const none = await server.inject({
      method: "POST",
      url: `/api/assets/${a}/replace`,
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\ny\r\n--${boundary}--\r\n`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(none.json().error.code).toBe("NO_FILE");
    await server.close();
  });

  it("字段太多 400（不让人把后端撑爆）", async () => {
    const b = await bootVariants();
    const { a } = await reviewing(b);
    const server = await app();
    const res = await server.inject({
      method: "POST",
      url: `/api/assets/${a}/replace`,
      ...multipart("x.png", Buffer.from("x"), 101),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("TOO_MANY_FIELDS");
    await server.close();
  });
});

describe("通过、打回、重跑", () => {
  it("有缺口不能通过 409；打回意见为空 400；打回后回到写稿；重跑前提不满足 409", async () => {
    const b = await bootVariants();
    const { id } = await reviewing(b);
    const server = await app();
    const approve = await server.inject({ method: "POST", url: `/api/variants/${id}/approve` });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error.code).toBe("ASSETS_HAVE_GAPS");
    const empty = await server.inject({ method: "POST", url: `/api/variants/${id}/rework`, payload: { note: " " } });
    expect(empty.statusCode).toBe(400);
    const rework = await server.inject({
      method: "POST",
      url: `/api/variants/${id}/rework`,
      payload: { note: "换一张图" },
    });
    expect(rework.statusCode).toBe(200);
    await until(() => b.statusOf(id) === "agent_running", "回到写稿");
    const rerun = await server.inject({ method: "POST", url: `/api/variants/${id}/rerun` });
    expect(rerun.statusCode).toBe(409);
    expect(rerun.json().error.code).toBe("NOT_RERUNNABLE");
    await server.close();
  });
});
