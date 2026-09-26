import { describe, expect, it } from "vitest";
import { estimateFromPlan, secondsOf, type Rate } from "./estimate.js";

/**
 * 估价（REQ-006「估价来源」）。plan 的形状照 Phase 6 实跑 `hypit plan --json`（render.svrun）抄的：
 * providers[] 与 needs[] 按 request 对上，本地能力 pricing.kind = local，TokenDance 是 page + 价格页。
 */

const RENDER = "@hypit/render-hyperframes@1#render-visual";
const SEEDANCE = "@hypit/seedance@2#generate-video";

function plan(over: Record<string, unknown> = {}) {
  return {
    format: "hypit.cli-plan@1",
    ok: true,
    providerRequestCount: 1,
    unresolvedRequestCount: 0,
    unsupportedRequestCount: 0,
    providers: [
      {
        request: "r1",
        capability: RENDER,
        status: "resolved",
        endpoint: "hyperframes.local",
        pricing: { kind: "local" },
      },
      {
        request: "r2",
        capability: SEEDANCE,
        status: "resolved",
        endpoint: "tokendance.default",
        pricing: { kind: "page", url: "https://tokendance.space/models" },
      },
    ],
    needs: [
      {
        request: "r1",
        summary: { fields: { width: 1080, height: 1920, startFrame: 0, endFrameExclusive: 900, frameRate: "30/1" } },
      },
      { request: "r2", summary: { fields: { duration: 5 } } },
    ],
    preflight: { ok: true, diagnostics: [] },
    ...over,
  };
}

const perSecond: Rate = { capability: SEEDANCE, endpoint: null, unit: "second", usd: 0.1 };

describe("能估出来", () => {
  it("本地能力 $0；按秒计价用 needs 的时长：5 秒 × $0.1 = $0.5，价格页链接带上", () => {
    const e = estimateFromPlan(plan(), [perSecond]);
    expect(e.kind).toBe("ok");
    if (e.kind !== "ok") return;
    expect(e.totalUsd).toBeCloseTo(0.5);
    expect(e.lines.find((l) => l.capability === RENDER)).toMatchObject({ local: true, usd: 0 });
    expect(e.lines.find((l) => l.capability === SEEDANCE)).toMatchObject({
      count: 1,
      usd: 0.5,
      pricingUrl: "https://tokendance.space/models",
    });
  });

  it("按次计价；指定 Endpoint 的单价优先于通用单价", () => {
    const rates: Rate[] = [
      { capability: SEEDANCE, endpoint: null, unit: "request", usd: 9 },
      { capability: SEEDANCE, endpoint: "tokendance.default", unit: "request", usd: 0.28 },
    ];
    const e = estimateFromPlan(plan(), rates);
    expect(e.kind === "ok" && e.totalUsd).toBeCloseTo(0.28);
  });

  it("本地能力在费率表里写了单价就按写的算（把本机渲染也记成本）", () => {
    const e = estimateFromPlan(plan(), [perSecond, { capability: RENDER, endpoint: null, unit: "second", usd: 0.01 }]);
    // 900 帧 / 30fps = 30 秒 × $0.01 = $0.3，加上 $0.5
    expect(e.kind === "ok" && e.totalUsd).toBeCloseTo(0.8);
  });

  it('时长从帧数与帧率算："30/1"、"30000/1001"', () => {
    expect(secondsOf({ startFrame: 0, endFrameExclusive: 900, frameRate: "30/1" })).toBe(30);
    expect(secondsOf({ startFrame: 0, endFrameExclusive: 30000, frameRate: "30000/1001" })).toBeCloseTo(1001);
  });
});

describe("估价拿不到（整张按超限）", () => {
  it("费率表缺这个能力的单价", () => {
    const e = estimateFromPlan(plan(), []);
    expect(e.kind).toBe("ok");
    if (e.kind !== "ok") return;
    expect(e.totalUsd).toBeNull();
    expect(e.lines.find((l) => l.capability === SEEDANCE)).toMatchObject({
      usd: null,
      missing: "费率表里没有这个能力的单价",
    });
  });

  it("按秒计价，但 plan 没给出时长", () => {
    const e = estimateFromPlan(plan({ needs: [] }), [perSecond]);
    expect(e.kind === "ok" && e.totalUsd).toBeNull();
  });
});

describe("时长不是正数（Seedance 2.5 的 duration = -1 表示自动）", () => {
  it("按秒计价拿不到正数时长：这一行拿不到，整张拿不到；不会算出负价压低总价", () => {
    const withAuto = plan({
      providers: [
        ...plan().providers,
        {
          request: "r3",
          capability: "@hypit/seedream@1#image",
          status: "resolved",
          endpoint: "tokendance.default",
          pricing: { kind: "page", url: "https://tokendance.space/models" },
        },
      ],
      needs: [
        ...plan().needs.filter((n) => n.request !== "r2"),
        { request: "r2", summary: { fields: { duration: -1 } } },
        { request: "r3", summary: { fields: {} } },
      ],
    });
    const e = estimateFromPlan(withAuto, [
      perSecond,
      { capability: "@hypit/seedream@1#image", endpoint: null, unit: "request", usd: 0.04 },
    ]);
    expect(e.kind).toBe("ok");
    if (e.kind !== "ok") return;
    expect(e.totalUsd).toBeNull();
    expect(e.lines.find((l) => l.capability === SEEDANCE)).toMatchObject({
      usd: null,
      missing: "按秒计价，但 plan 没给出时长",
    });
    expect(secondsOf({ duration: 0 })).toBeNull();
    expect(secondsOf({ startFrame: 900, endFrameExclusive: 900, frameRate: "30/1" })).toBeNull();
  });
});

describe("不出片、直接失败", () => {
  it("有未解析请求：写明缺哪种能力", () => {
    const e = estimateFromPlan(
      plan({
        unresolvedRequestCount: 1,
        providers: [{ request: "r3", capability: "@hypit/tts@1#speak", status: "unresolved" }],
      }),
      [],
    );
    expect(e).toMatchObject({ kind: "blocked", reason: "有请求没有可用的 Provider：@hypit/tts@1#speak" });
  });

  it("请求本身有问题（requestIssueCount > 0 / ok:false）：不出片，issue 原文带出", () => {
    const e = estimateFromPlan(
      plan({
        ok: false,
        requestIssueCount: 1,
        needs: [{ request: "r2", issue: "prompt exceeds 2000 characters", summary: { fields: { duration: 5 } } }],
      }),
      [perSecond],
    );
    expect(e).toMatchObject({ kind: "blocked", reason: "plan 报请求有问题：prompt exceeds 2000 characters" });
    expect(estimateFromPlan(plan({ ok: false }), [perSecond])).toMatchObject({ kind: "blocked" });
  });

  it("没有 providers（没有 Runtime Host）但有请求：按拿不到处理，不是 $0", () => {
    const e = estimateFromPlan({ format: "hypit.cli-plan@1", ok: true, requestCount: 2, needs: [] }, []);
    expect(e).toMatchObject({ kind: "ok", totalUsd: null });
  });

  it("preflight 没过：原样带出诊断", () => {
    const e = estimateFromPlan(plan({ preflight: { ok: false, diagnostics: ["缺少 TOKENDANCE_API_KEY"] } }), [
      perSecond,
    ]);
    expect(e).toMatchObject({ kind: "blocked" });
    expect(e.kind === "blocked" && e.reason).toContain("缺少 TOKENDANCE_API_KEY");
  });
});
