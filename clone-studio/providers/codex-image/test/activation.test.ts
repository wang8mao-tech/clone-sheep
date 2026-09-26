import type { CanonicalValue } from "@hypit/hypit/endpoint-kit";
import { describe, expect, it } from "vitest";
import activation from "../src/activation.js";

type Activate = (context: {
  hostStateRoot: string;
  dataRoot: string;
  instance: string;
  pool?: string;
  config: CanonicalValue;
}) => {
  endpoint: { instance: { id: string; pool: string }; pricing?: unknown };
};

const facet = activation.hostFacets[0] as unknown as { implementation: { activate: Activate } };
const activate = (config: CanonicalValue, pool?: string) =>
  facet.implementation.activate({
    hostStateRoot: "h",
    dataRoot: "d",
    instance: "codex.local",
    ...(pool ? { pool } : {}),
    config,
  });

describe("activation：Runtime Profile 配置严格校验", () => {
  it("完整配置：建出 codex.local 的零价 endpoint", () => {
    const { endpoint } = activate(
      { command: "node", prefixArgs: ["C:/npm/codex.js"], codexHome: "C:/codex", timeoutMs: 600000, concurrency: 1 },
      "codex.local",
    );
    expect(endpoint.instance).toEqual({ id: "codex.local", pool: "codex.local" });
    expect(endpoint.pricing).toEqual({ kind: "local" });
  });

  it("多一个键、缺 command、prefixArgs 不是字符串数组、并发不是正整数：拒", () => {
    expect(() => activate({ command: "node", apiKey: "x" })).toThrow("does not accept apiKey");
    expect(() => activate({})).toThrow("requires command");
    expect(() => activate({ command: "node", prefixArgs: "codex.js" })).toThrow("list of non-empty strings");
    expect(() => activate({ command: "node", prefixArgs: [""] })).toThrow("list of non-empty strings");
    expect(() => activate({ command: "node", concurrency: 0 })).toThrow("positive integer");
  });

  it("没给 pool 用实例名", () => {
    expect(activate({ command: "node" }).endpoint.instance.pool).toBe("codex.local");
  });
});
