import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bootOutputs, useOutputsSandbox } from "./outputs-test-kit.js";

/**
 * 删成片要等这条成片正在跑的封面抽取结束（ffmpeg 开着文件时 Windows 删不掉）：9.1 第二 / 三轮审查。
 * 用一个挂住的工具调用把抽取卡在「已拿到名额、正在跑」，看删除会不会先等它
 */

useOutputsSandbox();

describe("DELETE /api/productions/:id/output 等在跑的抽取", () => {
  it("抽取在跑：删除挂着、文件还在；抽取一结束才删、回 200", async () => {
    const b = await bootOutputs();
    const id = b.production();
    const { output } = b.build(id);
    const tool = await import("../lib/image-tool.js");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(tool, "resolveTool").mockReturnValue("ffprobe");
    vi.spyOn(tool, "run").mockImplementation(async () => {
      await gate;
      return { code: 1, stdout: "", stderr: "", timedOut: false };
    });
    b.outputs.listOutputs(b.template.id); // 起后台抽取，卡在工具调用上
    await vi.waitFor(() => expect(tool.run).toHaveBeenCalled());

    const server = await b.app();
    let settled = false;
    const pending = server.inject({ method: "DELETE", url: `/api/productions/${id}/output` }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(false);
    expect(existsSync(output)).toBe(true);

    release();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(existsSync(output)).toBe(false);
    await server.close();
  });

  it("没有在跑的抽取：不等", async () => {
    const b = await bootOutputs();
    const id = b.production();
    b.build(id);
    const server = await b.app();
    expect((await server.inject({ method: "DELETE", url: `/api/productions/${id}/output` })).statusCode).toBe(200);
    await server.close();
  });
});
