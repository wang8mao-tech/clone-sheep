import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootProfiles, COMPATIBLE, useProfileSandbox } from "./profiles-test-kit.js";

/** 模型档案的存储规则（Spec REQ-010 输入表与档案管理，Task 10.1） */

const root = useProfileSandbox();

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "NO_ERROR";
};

describe("内置订阅档案", () => {
  it("迁移种入：内置、默认、看图与搜索都开；再迁移一遍不重复", async () => {
    const b = await bootProfiles();
    b.migrate();
    const rows = b.profiles.listProfiles();
    expect(rows).toHaveLength(1);
    expect(b.profiles.presentProfile(rows[0]!)).toMatchObject({
      id: "subscription",
      name: "本机 Claude Code 订阅",
      kind: "subscription",
      builtin: true,
      isDefault: true,
      supportsVision: true,
      supportsWebSearch: true,
      token: null,
      budgetNote: null,
    });
  });

  it("不能改、不能删，只能设为默认", async () => {
    const b = await bootProfiles();
    expect(code(() => b.profiles.updateProfile("subscription", { name: "x" }))).toBe("BUILTIN_READONLY");
    expect(code(() => b.profiles.deleteProfile("subscription"))).toBe("BUILTIN_UNDELETABLE");
    const other = b.profiles.createProfile(COMPATIBLE);
    b.profiles.setDefaultProfile(other.id);
    b.profiles.setDefaultProfile("subscription");
    expect(
      b.profiles
        .listProfiles()
        .filter((p) => p.is_default === 1)
        .map((p) => p.id),
    ).toEqual(["subscription"]);
  });
});

describe("新建档案的校验（REQ-010 输入表）", () => {
  it("档案名 1-30 字、去首尾空白、不重名（含内置名）", async () => {
    const b = await bootProfiles();
    expect(code(() => b.profiles.createProfile({ ...COMPATIBLE, name: "   " }))).toBe("NAME_INVALID");
    expect(code(() => b.profiles.createProfile({ ...COMPATIBLE, name: "x".repeat(31) }))).toBe("NAME_INVALID");
    expect(b.profiles.createProfile({ ...COMPATIBLE, name: ` ${"名".repeat(30)} ` }).name).toBe("名".repeat(30));
    // 按字符数，emoji 算一个字
    expect(b.profiles.createProfile({ ...COMPATIBLE, name: "\u{1F680}".repeat(30) }).name).toBe("\u{1F680}".repeat(30));
    expect(code(() => b.profiles.createProfile({ ...COMPATIBLE, name: "本机 Claude Code 订阅" }))).toBe("NAME_TAKEN");
  });

  it("兼容端点的 base_url 必须 http / https，末尾斜杠去掉；官方 key 档案不收 base_url", async () => {
    const b = await bootProfiles();
    for (const bad of ["", "api.deepseek.com", "ftp://x.com", "javascript:alert(1)"]) {
      expect(code(() => b.profiles.createProfile({ ...COMPATIBLE, baseUrl: bad }))).toBe("BASE_URL_INVALID");
    }
    expect(b.profiles.createProfile(COMPATIBLE).base_url).toBe("https://api.deepseek.com/anthropic");
    const official = b.profiles.createProfile({
      ...COMPATIBLE,
      name: "官方",
      kind: "anthropic",
      baseUrl: "https://evil",
    });
    expect(official.base_url).toBeNull();
  });

  it("token 与主模型必填，单价不能为负、可以空", async () => {
    const b = await bootProfiles();
    expect(code(() => b.profiles.createProfile({ ...COMPATIBLE, token: "  " }))).toBe("TOKEN_REQUIRED");
    // 带空白 / 控制字符 / 非 ASCII 的 key 不收：拼请求头时的报错会把明文带回界面（10.1 审查 M2）
    for (const bad of ["sk-abc\ndef1234567", "sk-abc def1234567", "sk-abc\u0000def123", "sk-密钥abcdef123"]) {
      expect(
        code(() => b.profiles.createProfile({ ...COMPATIBLE, token: bad })),
        JSON.stringify(bad),
      ).toBe("TOKEN_INVALID");
    }
    const row = b.profiles.createProfile(COMPATIBLE);
    expect(code(() => b.profiles.updateProfile(row.id, { token: "sk-new\ntoken12345" }))).toBe("TOKEN_INVALID");
    expect(b.profiles.profileToken(row.id)).toBe(COMPATIBLE.token);
    expect(code(() => b.profiles.createProfile({ ...COMPATIBLE, name: "无模型", modelId: " " }))).toBe(
      "MODEL_REQUIRED",
    );
    expect(code(() => b.profiles.createProfile({ ...COMPATIBLE, name: "负价", priceIn: -1 }))).toBe("PRICE_INVALID");
    expect(code(() => b.profiles.createProfile({ ...COMPATIBLE, name: "非数", priceOut: Number.NaN }))).toBe(
      "PRICE_INVALID",
    );
    const free = b.profiles.createProfile({ ...COMPATIBLE, name: "无价", priceIn: null, priceOut: null });
    expect(b.profiles.presentProfile(free).budgetNote).toBe(b.profiles.NO_PRICE_NOTE);
    expect(b.profiles.presentProfile(free).fastModelId).toBeNull();
  });
});

describe("token 只进 secrets.json（REQ-008 同款）", () => {
  it("库里没有明文，接口视图只给打码值，明文只从 profileToken 拿", async () => {
    const b = await bootProfiles();
    const row = b.profiles.createProfile(COMPATIBLE);
    expect(JSON.stringify(b.db().prepare("SELECT * FROM model_profiles").all())).not.toContain(COMPATIBLE.token);
    const view = b.profiles.presentProfile(row);
    expect(view.token).toBe(`sk-${"•".repeat(12)}abcd`);
    expect(JSON.stringify(view)).not.toContain(COMPATIBLE.token);
    expect(b.profiles.profileToken(row.id)).toBe(COMPATIBLE.token);
    expect(readFileSync(b.paths.secrets, "utf8")).toContain(COMPATIBLE.token);
    // 库文件本身也不含明文（WAL 里也没有）
    for (const file of readdirSync(root()).filter((f) => f.startsWith("app.db"))) {
      expect(readFileSync(`${root()}/${file}`).includes(Buffer.from(COMPATIBLE.token))).toBe(false);
    }
  });
});

describe("改档案", () => {
  it("token 不填沿用原来的；改连接字段清掉「已验证」，只改名字与能力不清", async () => {
    const b = await bootProfiles();
    const row = b.profiles.createProfile(COMPATIBLE);
    const verify = () => b.profiles.markVerified(row.id, "2026-09-25T00:00:00.000Z");

    verify();
    b.profiles.updateProfile(row.id, { name: "DS", token: "", supportsVision: false, priceIn: 1 });
    expect(b.profiles.profileToken(row.id)).toBe(COMPATIBLE.token);
    expect(b.profiles.requireProfile(row.id).verified_at).not.toBeNull();

    for (const patch of [
      { supportsVision: true },
      { baseUrl: "https://other.example.com" },
      { modelId: "deepseek-v4-pro" },
      { fastModelId: "deepseek-flash" },
      { token: "sk-new-token-0000000000" },
    ]) {
      verify();
      b.profiles.updateProfile(row.id, patch);
      expect(b.profiles.requireProfile(row.id).verified_at, JSON.stringify(patch)).toBeNull();
    }
    expect(b.profiles.profileToken(row.id)).toBe("sk-new-token-0000000000");
  });

  it("改名撞上别的档案：NAME_TAKEN；改成自己原来的名字不算撞", async () => {
    const b = await bootProfiles();
    const a = b.profiles.createProfile(COMPATIBLE);
    b.profiles.createProfile({ ...COMPATIBLE, name: "另一个" });
    expect(code(() => b.profiles.updateProfile(a.id, { name: "另一个" }))).toBe("NAME_TAKEN");
    expect(b.profiles.updateProfile(a.id, { name: "DeepSeek" }).name).toBe("DeepSeek");
  });
});

describe("删档案", () => {
  const job = (b: Awaited<ReturnType<typeof bootProfiles>>, profileId: string, status: string) =>
    b
      .db()
      .prepare(
        `INSERT INTO agent_jobs (id, owner_kind, owner_id, status, profile_id, profile_name, model_id, created_at, updated_at)
         VALUES (?, 'template', 't1', ?, ?, 'DeepSeek', 'deepseek-flash', '2026-09-25', '2026-09-25')`,
      )
      .run(`job-${status}`, status, profileId);

  it("还有没结束的任务在用：不能删；都结束了能删，历史任务的档案名与模型 id 不变（AC-030）", async () => {
    const b = await bootProfiles();
    const row = b.profiles.createProfile(COMPATIBLE);
    job(b, row.id, "done");
    for (const status of ["queued", "running", "awaiting_quota"]) {
      job(b, row.id, status);
      expect(
        code(() => b.profiles.deleteProfile(row.id)),
        status,
      ).toBe("PROFILE_IN_USE");
      b.db().prepare("DELETE FROM agent_jobs WHERE id = ?").run(`job-${status}`);
    }
    b.profiles.deleteProfile(row.id);
    expect(b.profiles.findProfile(row.id)).toBeUndefined();
    expect(b.profiles.profileToken(row.id)).toBeUndefined();
    expect(b.db().prepare("SELECT profile_name, model_id FROM agent_jobs WHERE id = 'job-done'").get()).toEqual({
      profile_name: "DeepSeek",
      model_id: "deepseek-flash",
    });
  });

  it("删的是默认档案：默认回到内置订阅", async () => {
    const b = await bootProfiles();
    const row = b.profiles.createProfile(COMPATIBLE);
    b.profiles.setDefaultProfile(row.id);
    expect(b.profiles.defaultProfile().id).toBe(row.id);
    b.profiles.deleteProfile(row.id);
    expect(b.profiles.defaultProfile().id).toBe("subscription");
    expect(b.profiles.listProfiles().filter((p) => p.is_default === 1)).toHaveLength(1);
  });

  it("不存在的档案：404", async () => {
    const b = await bootProfiles();
    expect(code(() => b.profiles.deleteProfile("nope"))).toBe("PROFILE_NOT_FOUND");
    expect(code(() => b.profiles.setDefaultProfile("nope"))).toBe("PROFILE_NOT_FOUND");
  });
});

describe("老库迁移（v10）", () => {
  it("补上 agent_jobs.profile_id；已有别的默认档案时，种入的订阅档案不抢默认", async () => {
    const b = await bootProfiles();
    const d = b.db();
    d.exec("ALTER TABLE agent_jobs DROP COLUMN profile_id");
    d.exec("ALTER TABLE model_profiles DROP COLUMN updated_at");
    d.prepare("DELETE FROM schema_migrations WHERE version = 10").run();
    d.prepare("DELETE FROM model_profiles").run();
    d.prepare(
      `INSERT INTO model_profiles (id, name, kind, base_url, model_id, is_default, builtin, created_at)
       VALUES ('p1', '老档案', 'compatible', 'https://x.example.com', 'm', 1, 0, '2026-09-01')`,
    ).run();
    b.migrate();
    const columns = (d.prepare("PRAGMA table_info(agent_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("profile_id");
    const profileColumns = (d.prepare("PRAGMA table_info(model_profiles)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(profileColumns).toContain("updated_at");
    const defaults = b.profiles
      .listProfiles()
      .filter((p) => p.is_default === 1)
      .map((p) => p.id);
    expect(defaults).toEqual(["p1"]);
    expect(b.profiles.findProfile("subscription")?.builtin).toBe(1);
  });
});

describe("「本机订阅 · 指定模型」档案", () => {
  it("不收 base_url 与 token（给了也不存），只要模型；没有单价提示", async () => {
    const b = await bootProfiles();
    const row = b.profiles.createProfile({
      name: "订阅 · Sonnet",
      kind: "subscription",
      baseUrl: "https://evil.example.com",
      token: "sk-should-not-be-stored-123",
      modelId: "claude-sonnet-5",
      supportsVision: true,
      supportsWebSearch: true,
    });
    expect(row).toMatchObject({ kind: "subscription", base_url: null, model_id: "claude-sonnet-5", builtin: 0 });
    expect(b.profiles.profileToken(row.id)).toBeUndefined();
    expect(b.profiles.presentProfile(row)).toMatchObject({ token: null, budgetNote: null });
    expect(
      code(() => b.profiles.createProfile({ ...COMPATIBLE, name: "订阅2", kind: "subscription", modelId: "" })),
    ).toBe("MODEL_REQUIRED");
    // 能改、能删（不是内置的那个）
    expect(b.profiles.updateProfile(row.id, { modelId: "claude-opus-5-5" }).model_id).toBe("claude-opus-5-5");
    b.profiles.deleteProfile(row.id);
  });
});
