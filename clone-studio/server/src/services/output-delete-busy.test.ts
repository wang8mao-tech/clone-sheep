import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bootOutputs, useOutputsSandbox } from "./outputs-test-kit.js";

/** 删成片时文件被别的程序占用（Windows 上播放器 / ffmpeg 开着，unlink 报 EBUSY）：9.1 第二轮审查 S2-M1 */

const busy = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    unlinkSync: (p: import("node:fs").PathLike) => {
      if (busy.path && String(p) === busy.path) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${String(p)}'`), { code: "EBUSY" });
      }
      real.unlinkSync(p);
    },
  };
});

useOutputsSandbox();

describe("DELETE /api/productions/:id/output：文件被占用", () => {
  it("409 OUTPUT_FILE_BUSY、回的话里没有路径；这条不标删除，网格里还在；放开之后能删", async () => {
    const b = await bootOutputs();
    const id = b.production({ name: "占用中" });
    const { output } = b.build(id);
    busy.path = output;
    const server = await b.app();
    const res = await server.inject({ method: "DELETE", url: `/api/productions/${id}/output` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("OUTPUT_FILE_BUSY");
    expect(res.body).not.toContain(b.dataRoot.replaceAll("\\", "\\\\"));
    expect(res.body).not.toContain("output");
    expect(b.outputs.listOutputs(b.template.id).map((o) => o.id)).toEqual([id]);
    expect(existsSync(output)).toBe(true);

    busy.path = "";
    expect((await server.inject({ method: "DELETE", url: `/api/productions/${id}/output` })).statusCode).toBe(200);
    expect(existsSync(output)).toBe(false);
    await server.close();
  });
});
