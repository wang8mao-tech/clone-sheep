import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  Breaker,
  IDLE_MS,
  QUOTA_FALLBACK_MS,
  QUOTA_MAX_WAIT_MS,
  QUOTA_MIN_WAIT_MS,
  resumeTime,
  type Verdict,
} from "./breaker.js";
import { fakeClock } from "./clock-test-kit.js";

const MIN = 60_000;

function setup(wallMs = 45 * MIN) {
  const clock = fakeClock();
  const verdicts: Verdict[] = [];
  const breaker = new Breaker({ wallMs }, (v) => verdicts.push(v), clock);
  return { clock, verdicts, breaker };
}

let n = 0;
function bash(command: string): { use: SDKMessage; result: (isError: boolean) => SDKMessage } {
  const id = `tu_${++n}`;
  const use = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  } as unknown as SDKMessage;
  const result = (isError: boolean) =>
    ({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "x" }] },
    }) as unknown as SDKMessage;
  return { use, result };
}

const heartbeat = { type: "tool_progress", tool_use_id: "t", elapsed_time_seconds: 30 } as unknown as SDKMessage;

describe("Breaker：墙钟", () => {
  it("到点熔断，原因 timeout", () => {
    const { clock, verdicts, breaker } = setup(45 * MIN);
    for (let i = 0; i < 44; i++) {
      clock.advance(MIN);
      breaker.observe(heartbeat);
    }
    expect(verdicts).toEqual([]);
    // 一直有消息也照样到点停：墙钟不因为有活动而延长
    clock.advance(MIN);
    expect(verdicts).toEqual([expect.objectContaining({ kind: "trip", reason: "timeout" })]);
  });

  it("自动续跑传进来的是剩余时间", () => {
    const { clock, verdicts } = setup(5 * MIN);
    clock.advance(5 * MIN);
    expect(verdicts[0]).toMatchObject({ reason: "timeout" });
  });
});

describe("Breaker：卡死（10 分钟无消息）", () => {
  it("10 分钟一条消息都没有：熔断，原因 idle", () => {
    const { clock, verdicts } = setup();
    clock.advance(IDLE_MS - 1);
    expect(verdicts).toEqual([]);
    clock.advance(1);
    expect(verdicts).toEqual([expect.objectContaining({ kind: "trip", reason: "idle" })]);
  });

  it("长命令期间的心跳消息会重置计时（实测约 30 秒一条）", () => {
    const { clock, verdicts, breaker } = setup();
    for (let i = 0; i < 30; i++) {
      clock.advance(30_000);
      breaker.observe(heartbeat);
    }
    expect(verdicts).toEqual([]);
  });
});

describe("Breaker：同一条命令连续失败 5 次", () => {
  it("第 5 次失败熔断，detail 带命令原文", () => {
    const { verdicts, breaker } = setup();
    for (let i = 0; i < 5; i++) {
      const c = bash("hypit check a.svml --json");
      breaker.observe(c.use);
      breaker.observe(c.result(true));
    }
    expect(verdicts).toEqual([
      { kind: "trip", reason: "repeated_failure", detail: expect.stringContaining("hypit check a.svml --json") },
    ]);
  });

  it("中间成功一次就清零", () => {
    const { verdicts, breaker } = setup();
    const run = (ok: boolean) => {
      const c = bash("hypit check a.svml");
      breaker.observe(c.use);
      breaker.observe(c.result(!ok));
    };
    for (let i = 0; i < 4; i++) run(false);
    run(true);
    for (let i = 0; i < 4; i++) run(false);
    expect(verdicts).toEqual([]);
  });

  it("不同命令各算各的；非 shell 工具不计", () => {
    const { verdicts, breaker } = setup();
    for (let i = 0; i < 4; i++) {
      for (const cmd of ["hypit check a", "hypit check b"]) {
        const c = bash(cmd);
        breaker.observe(c.use);
        breaker.observe(c.result(true));
      }
    }
    breaker.observe({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "x" } }] },
    } as unknown as SDKMessage);
    for (let i = 0; i < 6; i++) {
      breaker.observe({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "r1", is_error: true }] },
      } as unknown as SDKMessage);
    }
    expect(verdicts).toEqual([]);
  });
});

describe("Breaker：花费与限流", () => {
  it("error_max_budget_usd 结果：熔断，原因 budget", () => {
    const { verdicts, breaker } = setup();
    breaker.observe({ type: "result", subtype: "error_max_budget_usd" } as unknown as SDKMessage);
    expect(verdicts).toEqual([expect.objectContaining({ kind: "trip", reason: "budget" })]);
  });

  it("限流 rejected：等待额度，续跑时间取 resetsAt（Unix 秒）", () => {
    const { verdicts, breaker } = setup();
    breaker.observe({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 4_600 },
    } as unknown as SDKMessage);
    // 假时钟从 1_000_000ms 起，4600 秒后 = 4_600_000ms
    expect(verdicts).toEqual([{ kind: "quota", resumeAt: new Date(4_600_000) }]);
  });

  it("限流 allowed / allowed_warning：什么都不做", () => {
    const { verdicts, breaker } = setup();
    for (const status of ["allowed", "allowed_warning"]) {
      breaker.observe({ type: "rate_limit_event", rate_limit_info: { status } } as unknown as SDKMessage);
    }
    expect(verdicts).toEqual([]);
  });

  it("助手消息带 error: rate_limit（没有 rejected 事件的那条通道）：同样等待额度（复审 S1-M1）", () => {
    const { verdicts, breaker } = setup();
    breaker.observe({ type: "assistant", error: "rate_limit", message: { content: [] } } as unknown as SDKMessage);
    expect(verdicts).toEqual([expect.objectContaining({ kind: "quota" })]);
  });

  it("SDK 自己在重试的 api_retry 不算：它会自己恢复", () => {
    const { verdicts, breaker } = setup();
    breaker.observe({ type: "system", subtype: "api_retry", error: "rate_limit" } as unknown as SDKMessage);
    expect(verdicts).toEqual([]);
  });

  it("重置时间已经过了：至少等 1 分钟，不立刻重开进程撞墙（复审 S2-M2）", () => {
    expect(resumeTime(1_000, 5_000_000).getTime()).toBe(5_000_000 + QUOTA_MIN_WAIT_MS);
  });

  it("续跑后超时，原因里写设置的总时长而不是剩下的", () => {
    const clock = fakeClock();
    const verdicts: Verdict[] = [];
    new Breaker({ wallMs: 5 * MIN, totalWallMs: 45 * MIN, idleMs: 60 * MIN }, (v) => verdicts.push(v), clock);
    clock.advance(5 * MIN);
    expect(verdicts[0]).toMatchObject({ reason: "timeout", detail: "运行超过 45 分钟" });
  });

  it("重置时间远得离谱（单位判断错了）：最多等 24 小时，不让定时器溢出成立刻触发（复审 S2-L7）", () => {
    const now = 1_000_000;
    expect(resumeTime(1_900_000_000_000_000, now).getTime()).toBe(now + QUOTA_MAX_WAIT_MS);
  });

  it("resumeTime：毫秒原样用，缺失时隔 30 分钟", () => {
    expect(resumeTime(1_900_000_000_000, 1_900_000_000_000 - 60_000).getTime()).toBe(1_900_000_000_000);
    expect(resumeTime(undefined, 5).getTime()).toBe(5 + QUOTA_FALLBACK_MS);
  });
});

describe("Breaker：只判一次", () => {
  it("判过之后不再判，stop 之后计时器不再触发", () => {
    const { clock, verdicts, breaker } = setup(MIN);
    breaker.observe({ type: "result", subtype: "error_max_budget_usd" } as unknown as SDKMessage);
    clock.advance(IDLE_MS * 2);
    expect(verdicts).toHaveLength(1);

    const other = setup(MIN);
    other.breaker.stop();
    other.clock.advance(IDLE_MS * 2);
    expect(other.verdicts).toEqual([]);
  });
});
