import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataRoot: string;

async function fresh() {
  process.env.CLONE_STUDIO_DATA_ROOT = dataRoot;
  vi.resetModules();
  return import("./secrets.js");
}

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "clone-studio-secrets-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("secrets", () => {
  it("打码保留前 3 后 4，中间固定 12 点", async () => {
    const s = await fresh();
    s.setSecret("tokendance.apiKey", "td-abcdefghijklmnop3f9a");
    expect(s.maskSecret("tokendance.apiKey")).toBe(`td-${"•".repeat(12)}3f9a`);
  });

  it("短 key 整串打掉，不露两头", async () => {
    const s = await fresh();
    s.setSecret("tokendance.apiKey", "short123");
    const masked = s.maskSecret("tokendance.apiKey");
    expect(masked).toBe("•".repeat(12));
    expect(masked).not.toContain("short");
  });

  it("未配置时打码值为 null，而不是空串", async () => {
    const s = await fresh();
    expect(s.maskSecret("tokendance.apiKey")).toBeNull();
    expect(s.hasSecret("tokendance.apiKey")).toBe(false);
  });

  it("写 null 或空串等于删除", async () => {
    const s = await fresh();
    s.setSecret("tokendance.apiKey", "td-abcdefghijklmnop3f9a");
    s.setSecret("tokendance.apiKey", null);
    expect(s.hasSecret("tokendance.apiKey")).toBe(false);

    s.setSecret("tokendance.apiKey", "td-abcdefghijklmnop3f9a");
    s.setSecret("tokendance.apiKey", "   ");
    expect(s.hasSecret("tokendance.apiKey")).toBe(false);
  });

  it("密钥落在数据根目录的 secrets.json，不在别处", async () => {
    const s = await fresh();
    s.setSecret("tokendance.apiKey", "td-abcdefghijklmnop3f9a");
    const file = path.join(dataRoot, "secrets.json");
    expect(readFileSync(file, "utf8")).toContain("td-abcdefghijklmnop3f9a");
  });

  it("文件被写坏时当作空，不让后端起不来", async () => {
    const s = await fresh();
    s.setSecret("tokendance.apiKey", "td-abcdefghijklmnop3f9a");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(dataRoot, "secrets.json"), "{ 这不是 JSON", "utf8");

    const s2 = await fresh();
    expect(s2.hasSecret("tokendance.apiKey")).toBe(false);
    expect(s2.maskSecret("tokendance.apiKey")).toBeNull();
  });

  it("credentialEnv 只吐已配置的项，没配的不留空串", async () => {
    const s = await fresh();
    expect(s.credentialEnv()).toEqual({});
    s.setSecret("tokendance.apiKey", "td-abcdefghijklmnop3f9a");
    expect(s.credentialEnv()).toEqual({ TOKENDANCE_API_KEY: "td-abcdefghijklmnop3f9a" });
  });

  it("前后空白被裁掉：粘贴 key 时常带换行", async () => {
    const s = await fresh();
    s.setSecret("tokendance.apiKey", "  td-abcdefghijklmnop3f9a\n");
    expect(s.getSecret("tokendance.apiKey")).toBe("td-abcdefghijklmnop3f9a");
  });
});
