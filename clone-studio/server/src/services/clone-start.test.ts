import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boot, tick, until, uploadFile, useCloneSandbox } from "./clone-test-kit.js";

/** 复刻自动启动（FLOW-002 步骤 3）：新导入完成才起、已有模板不补跑、换参考视频的边界 */

useCloneSandbox();

describe("自动启动", () => {
  it("证据准备做完就自动起复刻任务，提示里带语言与复刻备注", async () => {
    const b = await boot();
    await b.evidence.startEvidence({
      templateId: b.templateId,
      source: { kind: "file", path: uploadFile() },
      language: "en",
      note: "节奏要快",
    });
    await until(() => b.latestJob() !== undefined, "复刻任务建出来");

    const job = b.latestJob();
    expect(job?.prompt).toContain("语言 en");
    expect(job?.prompt).toContain("节奏要快");
    await until(() => b.calls.length === 1, "会话开跑");
    expect(b.calls[0]?.input.prompt).toBe(job?.prompt);
  });

  it("已有模板不补跑：库里本来就停在「复刻中」的模板，启动接上编排后不会被起任务", async () => {
    const b = await boot({ register: false });
    b.setStatus("cloning");
    // 模拟服务重启：迁移、接上编排，和 index.ts 同一个顺序
    (await import("../db/migrate.js")).migrate();
    b.register();
    await tick();

    expect(b.latestJob()).toBeUndefined();
    expect(b.calls).toHaveLength(0);
  });

  it("模板不在「复刻中」或已经有任务在跑：不起第二个", async () => {
    const b = await boot();
    b.setStatus("importing");
    expect(b.clone.startClone(b.templateId)).toBeUndefined();

    b.setStatus("cloning");
    expect(b.clone.startClone(b.templateId)).toBeDefined();
    expect(b.clone.startClone(b.templateId)).toBeUndefined();
    expect(b.db().prepare("SELECT COUNT(*) AS n FROM agent_jobs").get()).toEqual({ n: 1 });
  });

  it("启动函数抛错不会让证据流水线判失败", async () => {
    const b = await boot();
    const starter = await import("./clone-starter.js");
    starter.setCloneStarter(() => {
      throw new Error("调度器炸了");
    });
    await b.evidence.startEvidence({
      templateId: b.templateId,
      source: { kind: "file", path: uploadFile() },
      language: "zh",
    });
    await until(() => b.evidence.evidenceState(b.templateId).status === "done", "证据准备做完");
    const row = b.db().prepare("SELECT status FROM templates WHERE id = ?").get(b.templateId) as { status: string };
    expect(row.status).toBe("cloning");
  });
});

describe("换参考视频", () => {
  it("复刻任务还在跑：拒绝换参考视频与重试证据（409 AGENT_ACTIVE），证据文件不动", async () => {
    const b = await boot();
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);

    await expect(
      b.evidence.startEvidence({
        templateId: b.templateId,
        source: { kind: "file", path: uploadFile() },
        language: "zh",
      }),
    ).rejects.toMatchObject({ code: "AGENT_ACTIVE", status: 409 });
    expect(() => b.evidence.retryEvidence(b.templateId, "transcribe")).toThrow(/复刻任务还在跑/);
  });

  it("上一轮做完后换参考视频：新一轮起之前清掉旧产物、作废没出片的旧复刻片", async () => {
    const b = await boot();
    // plan 跑不起来 → 复刻片停在待确认（$0 的会直接出片，出完的不是「没出片」）
    b.setPlan(new Error("plan 挂了"));
    b.setStatus("cloning");
    b.clone.startClone(b.templateId);
    b.writeProducts();
    await b.finishRun();
    await until(() => b.clone.latestReplica(b.templateId) !== undefined, "旧复刻片建出来");

    b.writeProducts(["ANALYSIS.md"]);
    const next = b.clone.startClone(b.templateId);
    expect(next).toBeDefined();
    expect(existsSync(path.join(b.workspace, "ANALYSIS.md"))).toBe(false);
    expect(existsSync(path.join(b.workspace, "reference.svrun"))).toBe(false);
    // 作废的不算当前复刻片，估价不会拿它
    expect(b.clone.latestReplica(b.templateId)).toBeUndefined();
    const statuses = b.db().prepare("SELECT status FROM productions WHERE template_id = ?").all(b.templateId);
    expect(statuses).toEqual([{ status: "cancelled" }]);
  });
});
