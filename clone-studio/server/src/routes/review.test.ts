import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boot, until, useCloneSandbox, type Booted } from "../services/clone-test-kit.js";
import { released, templateStatus } from "../services/build-test-kit.js";

/** ③ 验货接口：版本列表、复刻片播放（range）、通过、打回的参数校验 */

useCloneSandbox();

async function app() {
  const Fastify = (await import("fastify")).default;
  const { reviewRoutes } = await import("./review.js");
  const server = Fastify();
  await server.register(reviewRoutes);
  return server;
}

async function reviewing(b: Booted): Promise<string> {
  const id = await released(b);
  await until(() => templateStatus(b) === "awaiting_review", "等验货");
  return id;
}

describe("GET /api/templates/:id/review", () => {
  it("给版本列表与可做的动作；模板不存在 404", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    const server = await app();
    const res = await server.inject({ url: `/api/templates/${b.templateId}/review` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ approvable: true, reworkable: true, versions: [{ id: v1, version: 1 }] });
    expect((await server.inject({ url: "/api/templates/nope/review" })).statusCode).toBe(404);
    await server.close();
  });
});

describe("GET /api/productions/:id/video", () => {
  it("出完的复刻片按 range 给：整段 200、区间 206；没出完 404 NO_OUTPUT；不存在 404", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    const server = await app();
    const whole = await server.inject({ url: `/api/productions/${v1}/video` });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.body).toBe("fake mp4");
    const part = await server.inject({ url: `/api/productions/${v1}/video`, headers: { range: "bytes=0-3" } });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 0-3/8");
    expect(part.body).toBe("fake");

    b.db().prepare("UPDATE builds SET status = 'failed' WHERE production_id = ?").run(v1);
    const none = await server.inject({ url: `/api/productions/${v1}/video` });
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe("NO_OUTPUT");
    expect((await server.inject({ url: "/api/productions/nope/video" })).statusCode).toBe(404);
    await server.close();
  });

  it("台账里的导出路径指到数据根外面：403，不读", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "cs-outside-")), "x.mp4");
    writeFileSync(outside, "secret", "utf8");
    b.db().prepare("UPDATE builds SET output_path = ? WHERE production_id = ?").run(outside, v1);
    const server = await app();
    const res = await server.inject({ url: `/api/productions/${v1}/video` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("OUTSIDE_DATA_ROOT");
    // 指到数据根外一个不存在的文件：也是 403，不能靠「文件不在」回 404 泄露外面有没有这个文件
    b.db()
      .prepare("UPDATE builds SET output_path = ? WHERE production_id = ?")
      .run(path.join(path.dirname(outside), "missing.mp4"), v1);
    const missing = await server.inject({ url: `/api/productions/${v1}/video` });
    expect(missing.statusCode).toBe(403);
    await server.close();
  });
});

describe("POST approve / rework", () => {
  it("通过：200 带新的验货状态；缺 productionId 400；打回意见太长 400、空白 400", async () => {
    const b = await boot();
    const v1 = await reviewing(b);
    const server = await app();
    expect(
      (await server.inject({ method: "POST", url: `/api/templates/${b.templateId}/rework`, payload: { note: " " } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/templates/${b.templateId}/rework`,
          payload: { note: "x".repeat(5000) },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await server.inject({ method: "POST", url: `/api/templates/${b.templateId}/approve`, payload: {} })).statusCode,
    ).toBe(400);
    const ok = await server.inject({
      method: "POST",
      url: `/api/templates/${b.templateId}/approve`,
      payload: { productionId: v1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ templateStatus: "approved", approvedReplicaId: v1 });
    await server.close();
  });

  it("打回：200 带任务与验货状态，模板回到复刻中", async () => {
    const b = await boot();
    await reviewing(b);
    const server = await app();
    const res = await server.inject({
      method: "POST",
      url: `/api/templates/${b.templateId}/rework`,
      payload: { note: "节奏再快一点" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job: { status: expect.stringMatching(/queued|running/) } });
    expect(templateStatus(b)).toBe("cloning");
    await server.close();
  });
});
