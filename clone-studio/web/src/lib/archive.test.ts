import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { impactLines, type DeletionImpact } from "./archive.js";
import { inlineNameError } from "./useArchive.js";

function impact(over: Partial<DeletionImpact> = {}): DeletionImpact {
  return {
    kind: "client",
    id: "c1",
    name: "老王",
    templates: 0,
    productions: 0,
    runningTasks: 0,
    directories: [],
    ...over,
  };
}

describe("impactLines", () => {
  it("客户删除列出模板数，即便是 0 也要说清连带范围", () => {
    expect(impactLines(impact({ templates: 0 }))).toContain("连带删除 0 个模板");
  });

  it("模板删除不提模板数——那一栏对模板恒为 0，列出来只是噪音", () => {
    const lines = impactLines(impact({ kind: "template", templates: 0 }));
    expect(lines.some((l) => l.includes("个模板"))).toBe(false);
  });

  it("有运行中任务时按 AC-002 写明将中止几个", () => {
    expect(impactLines(impact({ runningTasks: 2 }))).toContain("将中止 2 个运行中的任务");
  });

  it("没有运行中任务就不出现「将中止」，免得用户以为有东西被杀", () => {
    const lines = impactLines(impact({ runningTasks: 0 }));
    expect(lines.some((l) => l.includes("将中止"))).toBe(false);
  });

  it("每个磁盘目录单独一行并标明不可恢复", () => {
    const lines = impactLines(impact({ directories: ["X:/data/a", "X:/data/b"] }));
    expect(lines).toContain("磁盘目录 X:/data/a 将被删除，不可恢复");
    expect(lines).toContain("磁盘目录 X:/data/b 将被删除，不可恢复");
  });

  it("模板全空时给一句兜底，弹窗的影响区不能是空白", () => {
    expect(impactLines(impact({ kind: "template" }))).toEqual(["没有连带内容，只删这一条记录"]);
  });
});

describe("inlineNameError", () => {
  it("409 NAME_TAKEN 走就地红字，原文直接用后端的（AC-003）", () => {
    const err = new ApiError("名称已存在", 409, undefined, "NAME_TAKEN");
    expect(inlineNameError(err)).toBe("名称已存在");
  });

  it("400 NAME_TOO_LONG 同样就地", () => {
    expect(inlineNameError(new ApiError("客户名最长 40 字", 400, undefined, "NAME_TOO_LONG"))).toBe(
      "客户名最长 40 字",
    );
  });

  it("DIRECTORY_BUSY 不是名称问题，必须落到 toast 而不是贴在输入框下", () => {
    expect(inlineNameError(new ApiError("目录被占用", 409, undefined, "DIRECTORY_BUSY"))).toBeUndefined();
  });

  it("没有 code 的错误（网络中断、502 之类）不就地显示", () => {
    expect(inlineNameError(new ApiError("请求失败（HTTP 502）", 502))).toBeUndefined();
  });

  it("非 ApiError 一律不就地显示", () => {
    expect(inlineNameError(new Error("boom"))).toBeUndefined();
    expect(inlineNameError("boom")).toBeUndefined();
  });
});
