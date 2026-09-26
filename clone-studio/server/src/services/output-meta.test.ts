import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bootOutputs, useOutputsSandbox } from "./outputs-test-kit.js";

/** ⑤ 成片的封面帧与时长（REQ-007）：后台取、同时最多 2 个、只缓存确定的结论、取的时候被删了不回写 */

useOutputsSandbox();

describe("封面帧与时长（后台取）", () => {
  it("第一次给占位、后台取完推 outputs 事件；再拉就有时长与封面，缓存下来不再跑 ffmpeg", async () => {
    const b = await bootOutputs();
    const id = b.production();
    const { output } = b.build(id, { file: "real" });
    const sse = await import("../lib/sse.js");
    const published = vi.spyOn(sse.sseHub, "publish");
    const [first] = b.outputs.listOutputs(b.template.id);
    expect(first).toMatchObject({ durationS: null, coverUrl: null, downloadable: true });
    await b.meta.metaIdle();
    expect(published).toHaveBeenCalledWith(`template:${b.template.id}`, "outputs", { meta: true }, undefined);
    const [card] = b.outputs.listOutputs(b.template.id);
    expect(card?.durationS).toBeCloseTo(3, 0);
    expect(card?.coverUrl?.startsWith(`/api/productions/${id}/cover?v=`)).toBe(true);
    expect(existsSync(b.meta.coverPathFor(output))).toBe(true);

    const tool = await import("../lib/image-tool.js");
    const spy = vi.spyOn(tool, "run");
    b.outputs.listOutputs(b.template.id);
    await b.meta.metaIdle();
    expect(spy).not.toHaveBeenCalled();
  });

  it("文件不是视频（确定的结论）：时长与封面都空、不报错，记下检查过了不再重试", async () => {
    const b = await bootOutputs();
    const { id: buildId, output } = b.build(b.production(), { file: "fake mp4" });
    b.outputs.listOutputs(b.template.id);
    await b.meta.metaIdle();
    const [card] = b.outputs.listOutputs(b.template.id);
    expect(card).toMatchObject({ durationS: null, coverUrl: null, downloadable: true });
    expect(existsSync(b.meta.coverPathFor(output))).toBe(false);
    const row = b.d.prepare("SELECT meta_checked_at FROM builds WHERE id = ?").get(buildId) as {
      meta_checked_at: string;
    };
    expect(row.meta_checked_at).toBeTruthy();
  });

  it("ffmpeg / ffprobe 不在：给占位、不缓存；装好之后再打开就取到了（9.1 审查 S2-3）", async () => {
    const b = await bootOutputs();
    const { id: buildId } = b.build(b.production(), { file: "real" });
    const tool = await import("../lib/image-tool.js");
    const missing = vi.spyOn(tool, "resolveTool").mockImplementation(() => {
      throw new tool.ImageToolError("TOOL_MISSING", "ffmpeg 不在 PATH");
    });
    expect(await b.meta.ensureOutputMeta(buildId)).toBeNull();
    const row = () =>
      b.d.prepare("SELECT meta_checked_at FROM builds WHERE id = ?").get(buildId) as { meta_checked_at: string | null };
    expect(row().meta_checked_at).toBeNull();

    missing.mockRestore();
    expect((await b.meta.ensureOutputMeta(buildId))?.durationS).toBeCloseTo(3, 0);
    expect(row().meta_checked_at).toBeTruthy();
    // 缓存下来之后再来取：直接给缓存，不再跑工具
    const run = vi.spyOn(tool, "run");
    expect((await b.meta.ensureOutputMeta(buildId))?.durationS).toBeCloseTo(3, 0);
    expect(run).not.toHaveBeenCalled();
  });

  it("ffmpeg 超时：同样不缓存", async () => {
    const b = await bootOutputs();
    const { id: buildId } = b.build(b.production(), { file: "real" });
    const tool = await import("../lib/image-tool.js");
    vi.spyOn(tool, "run").mockResolvedValue({ code: -1, stdout: "", stderr: "", timedOut: true });
    expect(await b.meta.ensureOutputMeta(buildId)).toBeNull();
    expect(b.meta.cachedOutputMeta(buildId)).toBeNull();
  });

  it("同时最多跑 2 个工具；同一条并发来取只跑一次", async () => {
    const b = await bootOutputs();
    const builds = [1, 2, 3, 4, 5].map((n) => b.build(b.production({ name: `片${n}` }), { file: "real" }).id);
    const tool = await import("../lib/image-tool.js");
    const real = tool.run;
    let now = 0;
    let peak = 0;
    const spy = vi.spyOn(tool, "run").mockImplementation(async (exe, args) => {
      now += 1;
      peak = Math.max(peak, now);
      try {
        return await real(exe, args);
      } finally {
        now -= 1;
      }
    });
    const [a, again] = [b.meta.ensureOutputMeta(builds[0] as string), b.meta.ensureOutputMeta(builds[0] as string)];
    expect(again).toBe(a);
    b.outputs.listOutputs(b.template.id);
    await b.meta.metaIdle();
    expect(peak).toBeLessThanOrEqual(2);
    expect(spy).toHaveBeenCalledTimes(10); // 5 条 × (ffprobe + ffmpeg)，同一条没有重复跑
  });

  it("取的时候成片被标了删除（防御：直接调服务、不经删除接口的等待）：不回写、封面不留孤儿", async () => {
    const b = await bootOutputs();
    const id = b.production();
    const { id: buildId, output } = b.build(id, { file: "real" });
    const pending = b.meta.ensureOutputMeta(buildId);
    b.d.prepare("UPDATE productions SET output_deleted_at = 'x' WHERE id = ?").run(id);
    expect(await pending).toBeNull();
    expect(existsSync(b.meta.coverPathFor(output))).toBe(false);
    expect(b.meta.cachedOutputMeta(buildId)).toBeNull();
  });
});
