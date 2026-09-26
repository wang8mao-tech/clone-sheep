import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { until, useCloneSandbox } from "./clone-test-kit.js";
import { bootVariants } from "./variant-test-kit.js";

/** 变体的状态接力与完成判据（REQ-005、FLOW-003 步骤 3）；重跑只删 Agent 的素材（Task 5.2 复审 S1-M4） */

useCloneSandbox();

async function oneVariant() {
  const b = await bootVariants();
  const batch = b.submit(["换成 2026 年手机品牌排行，毒舌风格"]);
  const id = batch.variants[0]?.id as string;
  await until(() => b.calls.length === 1, "会话开跑");
  return { b, id };
}

describe("完成判据", () => {
  it("产物齐全、check 通过：按 SOURCES.json 建素材卡，进素材待审；check 在变体目录里跑、显式指模板目录", async () => {
    const { b, id } = await oneVariant();
    await until(() => b.statusOf(id) === "agent_running", "写稿中");
    b.writeProducts(id, {
      images: ["assets/01-a.jpg", "assets/02-gap.jpg", "assets/03-c.png"],
      sources: {
        assets: [
          { file: "assets/01-a.jpg", label: "A", sourceUrl: "https://example.com/a" },
          { file: "assets/02-gap.jpg", label: "缺口", gap: true, width: 100, height: 100 },
          { file: "./assets/03-c.png", label: "自画", sourceUrl: null },
        ],
      },
    });
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "asset_review", "进素材待审");
    const assets = b.vstore
      .listAssets(id)
      .map((a) => [a.file_path, a.label, a.source_url, a.is_gap, a.replaced_by_user]);
    expect(assets).toEqual([
      ["assets/01-a.jpg", "A", "https://example.com/a", 0, 0],
      ["assets/02-gap.jpg", "缺口", null, 1, 0],
      ["assets/03-c.png", "自画", null, 0, 0],
    ]);
    const check = b.hypitCalls.findIndex((args) => args[0] === "check");
    expect(b.hypitCalls[check]).toEqual(["check", "variant.svrun", "--workspace", b.workspace, "--json"]);
    expect(b.hypitOptions[check]?.cwd).toBe(b.dirOf(id));
  });

  it("缺 SOURCES.json / SCRIPT.md：任务改判失败写明缺什么，变体跟着失败；继续时把原因交给会话", async () => {
    const { b, id } = await oneVariant();
    b.writeProducts(id, { sources: null, script: false });
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "failed", "变体失败");
    const job = b.store.latestJobOf("production", id);
    expect(job?.status).toBe("failed");
    expect(job?.stop_reason).toBe("变体未达完成判据：缺少 SOURCES.json、SCRIPT.md");
    expect(b.clone.continuePromptFor(job?.id as string)).toContain(
      "宿主核对完成判据没有通过：缺少 SOURCES.json、SCRIPT.md",
    );
    // 继续 → 再次完成、这回齐了 → 素材待审
    b.service.agentScheduler().continueJob(job?.id as string, b.clone.continuePromptFor(job?.id as string));
    await until(() => b.calls.length === 2, "继续开跑");
    await until(() => b.statusOf(id) === "queued" || b.statusOf(id) === "agent_running", "回到 Agent 这一段");
    b.writeProducts(id);
    await b.finishCall(1);
    await until(() => b.statusOf(id) === "asset_review", "进素材待审");
  });

  it("check 没过：原因带上 hypit 的第一行", async () => {
    const { b, id } = await oneVariant();
    b.writeProducts(id);
    const { HypitError } = await import("../hypit/cli.js");
    b.setCheck(new HypitError("CHECK_FAILED", "reference 未声明：variant.svml:3"));
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "failed", "变体失败");
    expect(b.store.latestJobOf("production", id)?.stop_reason).toContain("hypit check 未通过：reference 未声明");
  });

  it.each([
    ["路径跑出变体目录", { assets: [{ file: "../../reference.svrun", label: "x" }] }, "跑出了变体目录"],
    ["列的图不存在", { assets: [{ file: "assets/nope.jpg", label: "x", sourceUrl: "https://a" }] }, "列的图不存在"],
    ["同一个文件写两次", { assets: [{ file: "assets/01-a.jpg" }, { file: "assets/01-a.jpg" }] }, "写了两次"],
    ["换个写法的同一个文件", { assets: [{ file: "assets/01-a.jpg" }, { file: "./assets//01-a.jpg" }] }, "写了两次"],
    ["列的是目录", { assets: [{ file: "assets" }] }, "列的图不存在"],
    ["列的不在 assets/ 下", { assets: [{ file: "SCRIPT.md" }] }, "要放在 assets/ 下"],
    ["缺口没放占位图", { assets: [{ file: "assets/09-gap.jpg", gap: true, width: 10, height: 10 }] }, "列的图不存在"],
    ["格式不对", { items: [] }, "格式不对"],
  ])("SOURCES.json %s：没过判据", async (_name, sources, reason) => {
    const { b, id } = await oneVariant();
    b.writeProducts(id, { sources });
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "failed", "变体失败");
    expect(b.store.latestJobOf("production", id)?.stop_reason).toContain(reason);
  });

  it("check 输出 ok 不是 true（没抛错）：同样没过", async () => {
    const { b, id } = await oneVariant();
    b.writeProducts(id);
    b.setCheck({ ok: false, diagnostics: ["x"] });
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "failed", "变体失败");
    expect(b.store.latestJobOf("production", id)?.stop_reason).toContain("check 输出 ok 不为 true");
  });

  it("SOURCES.json 不是 JSON：没过判据", async () => {
    const { b, id } = await oneVariant();
    b.writeProducts(id);
    writeFileSync(path.join(b.dirOf(id), "SOURCES.json"), "{oops", "utf8");
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "failed", "变体失败");
    expect(b.store.latestJobOf("production", id)?.stop_reason).toContain("不是合法 JSON");
  });

  it("核的过程中人取消了：不进素材待审", async () => {
    const { b, id } = await oneVariant();
    b.writeProducts(id);
    let release = () => undefined as void;
    b.setCheck(() => new Promise((resolve) => (release = () => resolve({ ok: true }))));
    await b.finishCall(0);
    await until(() => b.hypitCalls.some((a) => a[0] === "check"), "开始核");
    await b.variants.cancelVariant(id);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(b.statusOf(id)).toBe("cancelled");
    expect(b.vstore.listAssets(id)).toEqual([]);
  });
});

describe("来源地址", () => {
  it("只认 http / https：javascript:、file:、乱写的都当作无来源", async () => {
    const { b, id } = await oneVariant();
    b.writeProducts(id, {
      images: ["assets/01-a.jpg", "assets/02-b.jpg", "assets/03-c.jpg", "assets/04-d.jpg"],
      sources: {
        assets: [
          { file: "assets/01-a.jpg", sourceUrl: "javascript:alert(1)" },
          { file: "assets/02-b.jpg", sourceUrl: "file:///C:/x.jpg" },
          { file: "assets/03-c.jpg", sourceUrl: "不是网址" },
          { file: "assets/04-d.jpg", sourceUrl: "https://example.com/d" },
        ],
      },
    });
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "asset_review", "进素材待审");
    expect(b.vstore.listAssets(id).map((a) => a.source_url)).toEqual([null, null, null, "https://example.com/d"]);
  });
});

describe("状态同步", () => {
  it("熔断、中断、等待额度都同步到变体；已取消的不会被后来的任务状态拉回", async () => {
    const { b, id } = await oneVariant();
    const job = b.store.latestJobOf("production", id);
    const { updateJob } = b.store;
    const broadcast = (status: string) => {
      const row = updateJob(job?.id as string, { status: status as never });
      // 模拟调度器推状态（直接改库不会触发监听）
      b.flow.registerVariantFlow()();
      return row;
    };
    broadcast("tripped");
    expect(b.statusOf(id)).toBe("tripped");
    broadcast("interrupted");
    expect(b.statusOf(id)).toBe("interrupted");
    b.db().prepare("UPDATE productions SET status = 'cancelled' WHERE id = ?").run(id);
    broadcast("failed");
    expect(b.statusOf(id)).toBe("cancelled");
  });

  it("已经交给出片流水线的变体（有运行文件路径）：任务再怎么变也不改它的状态", async () => {
    const { b, id } = await oneVariant();
    await until(() => b.statusOf(id) === "agent_running", "写稿中");
    b.db().prepare("UPDATE productions SET run_path = 'x.svrun', status = 'queued' WHERE id = ?").run(id);
    const job = b.store.latestJobOf("production", id);
    await b.service.agentScheduler().abort(job?.id as string);
    expect(b.store.latestJobOf("production", id)?.status).toBe("interrupted");
    expect(b.statusOf(id)).toBe("queued");
  });

  it("重启：任务被标中断而变体还停在排队的，对齐成中断；完成了却没核的补核", async () => {
    const b = await bootVariants();
    const batch = b.submit(["换成手机品牌排行榜", "换成汽车品牌排行榜"]);
    const [a, c] = batch.variants.map((v) => v.id) as [string, string];
    await until(() => b.calls.length === 2, "两个会话开跑");
    b.unregisterFlow();
    // 模拟：进程死了——a 的任务被迁移标中断、变体还在 queued；c 的任务完成了但没来得及核
    const ja = b.store.latestJobOf("production", a)?.id as string;
    const jc = b.store.latestJobOf("production", c)?.id as string;
    b.store.updateJob(ja, { status: "interrupted" });
    b.db().prepare("UPDATE productions SET status = 'queued' WHERE id = ?").run(a);
    b.writeProducts(c);
    b.store.updateJob(jc, { status: "done", ended_at: new Date().toISOString() });
    b.flow.registerVariantFlow();
    expect(b.statusOf(a)).toBe("interrupted");
    await until(() => b.statusOf(c) === "asset_review", "补核后进素材待审");
  });
});

describe("重跑只删 Agent 的产物（Task 5.2 复审 S1-M4）", () => {
  it("清掉稿子、清单与 Agent 抓的图；模板原稿与用户替换过的图留下并列进 USER_ASSETS.json；新会话照原提示开跑", async () => {
    const { b, id } = await oneVariant();
    b.writeProducts(id);
    await b.finishCall(0);
    await until(() => b.statusOf(id) === "asset_review", "进素材待审");
    b.db()
      .prepare("UPDATE assets SET replaced_by_user = 1 WHERE production_id = ? AND file_path = ?")
      .run(id, "assets/02-b.jpg");
    const dir = b.dirOf(id);
    writeFileSync(path.join(dir, "reference.svrun"), "# 被会话改过\n", "utf8");
    // 重跑只对已结束的任务：这里把完成的任务当作失败了来重跑
    const job = b.store.latestJobOf("production", id);
    b.store.updateJob(job?.id as string, { status: "failed" });
    const next = b.service.agentScheduler().rerun(job?.id as string);
    expect(next.id).not.toBe(job?.id);
    expect(existsSync(path.join(dir, "reference.svrun"))).toBe(true);
    expect(existsSync(path.join(dir, "assets/02-b.jpg"))).toBe(true);
    expect(existsSync(path.join(dir, "assets/01-a.jpg"))).toBe(false);
    for (const gone of ["variant.svrun", "SOURCES.json", "SCRIPT.md"])
      expect(existsSync(path.join(dir, gone))).toBe(false);
    // 原稿从模板目录重新复制：上一个会话改过的不留
    expect(readFileSync(path.join(dir, "reference.svrun"), "utf8")).toBe("# reference.svrun\n");
    expect(JSON.parse(readFileSync(path.join(dir, "USER_ASSETS.json"), "utf8"))).toEqual({
      assets: ["assets/02-b.jpg"],
    });
    await until(() => b.calls.length === 2, "新会话开跑");
    expect(b.calls[1]?.input.workspace).toBe(dir);
    // 新会话写回清单时照原路径列了用户的图：仍记「已替换」
    b.writeProducts(id, { images: ["assets/01-a.jpg"] });
    await b.finishCall(1);
    await until(() => b.statusOf(id) === "asset_review", "再进素材待审");
    const replaced = b.vstore
      .listAssets(id)
      .filter((a) => a.replaced_by_user === 1)
      .map((a) => a.file_path);
    expect(replaced).toEqual(["assets/02-b.jpg"]);
  });
});

describe("工作目录", () => {
  it("变体任务的工作目录是模板目录下的 productions/<id>/；不存在的出片单位明确报错", async () => {
    const { b, id } = await oneVariant();
    expect(b.service.workspaceOf({ owner_kind: "production", owner_id: id })).toBe(b.dirOf(id));
    expect(() => b.service.workspaceOf({ owner_kind: "production", owner_id: "nope" })).toThrow(/出片单位不存在/);
  });
});
