import { describe, expect, it } from "vitest";
import { buildRuntimeProfile } from "./workspace.js";

const BASE = { renderWorkers: 4, renderConcurrency: 1 } as const;

describe("buildRuntimeProfile", () => {
  it("没有任何云端服务时，只绑本地能力，profile 仍是完整形态", () => {
    const p = buildRuntimeProfile({ ...BASE, tokendance: false, hypihub: false, whisperx: false });

    expect(p.format).toBe("hypit.runtime-local@1");
    expect(p.dataRoot).toBe(".hypit/execution");
    expect(Object.keys(p.endpoints).sort()).toEqual(["hyperframes.local", "media.local"]);
    // 每个 binding 都必须指向一个真的存在的 endpoint，绑到不存在的实例会在 plan 时才炸
    for (const [capability, instance] of Object.entries(p.bindings)) {
      expect(Object.keys(p.endpoints), `${capability} 绑到了不存在的 ${instance}`).toContain(instance);
    }
  });

  it("TokenDance 开启时带 pool 与 env 凭据引用，明文绝不出现在 profile 里", () => {
    const p = buildRuntimeProfile({ ...BASE, tokendance: true, hypihub: false, whisperx: false });

    const endpoint = p.endpoints["tokendance.default"];
    expect(endpoint).toBeDefined();
    // Provider 的 activation 会对缺 pool 直接抛错
    expect(endpoint?.pool).toBe("tokendance.default");
    expect(endpoint?.config?.apiKey).toEqual({ store: "env", key: "TOKENDANCE_API_KEY" });

    // 整份 profile 序列化后不该含任何疑似密钥的东西
    const text = JSON.stringify(p);
    expect(text).not.toMatch(/sk-|td-[A-Za-z0-9]{8}/);

    expect(p.bindings["@hypit/seedance@1#seedance-2.5"]).toBe("tokendance.default");
    expect(p.bindings["@hypit/seedream@1#seedream-5-lite"]).toBe("tokendance.default");
    expect(p.bindings["@hypit/minimax-h3@1#minimax-h3"]).toBe("tokendance.default");
  });

  it("关掉 TokenDance 时不留下悬空绑定", () => {
    const off = buildRuntimeProfile({ ...BASE, tokendance: false, hypihub: false, whisperx: false });
    expect(Object.keys(off.bindings).some((k) => k.startsWith("@hypit/seedance"))).toBe(false);
    expect(off.endpoints["tokendance.default"]).toBeUndefined();
  });

  it("HypiHub 只加 endpoint、不硬编码能力绑定", () => {
    const p = buildRuntimeProfile({ ...BASE, tokendance: false, hypihub: true, whisperx: false });
    expect(p.endpoints["hypihub.default"]).toBeDefined();
    // 它覆盖哪些能力由它自己的 README 决定；猜着绑不如让 plan 明确报缺能力
    expect(Object.values(p.bindings)).not.toContain("hypihub.default");
  });

  it("渲染并发原样落进 hyperframes 配置", () => {
    const p = buildRuntimeProfile({ tokendance: false, hypihub: false, whisperx: false, renderWorkers: 8, renderConcurrency: 2 });
    expect(p.endpoints["hyperframes.local"]?.config).toMatchObject({ workers: 8, defaultConcurrency: 2 });
  });

  it("credentials 永远声明 env store，否则 apiKey 引用解析不了", () => {
    const p = buildRuntimeProfile({ ...BASE, tokendance: true, hypihub: false, whisperx: false });
    expect(p.credentials.env).toEqual({ use: "@hypit/credential-store-env" });
  });
});
