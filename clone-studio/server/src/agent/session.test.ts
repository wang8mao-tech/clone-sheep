import path from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { agentEnv, assertSessionOptions, buildSessionOptions, guardHook } from "./session.js";

const WS = "C:/data/clients/c/templates/t";

function build(over: Partial<Parameters<typeof buildSessionOptions>[0]> = {}): Options {
  return buildSessionOptions({
    workspace: WS,
    pluginDir: "C:/data/agent-plugin",
    maxBudgetUsd: 5,
    onIntercept: () => {},
    ...over,
  });
}

describe("buildSessionOptions：Spec REQ-003 的每条硬约束", () => {
  const o = build();

  it("不继承用户 ~/.claude：settingSources 为空", () => {
    expect(o.settingSources).toEqual([]);
  });

  it("hypit skill 走插件，且只放行它", () => {
    expect(o.plugins).toEqual([{ type: "local", path: "C:/data/agent-plugin" }]);
    expect(o.skills).toEqual(["clone-studio:hypit"]);
  });

  it("完整能力：bypass 模式，不禁 Bash；子 Agent 工具两个名字都禁", () => {
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task"]));
    expect(o.disallowedTools).not.toContain("Bash");
  });

  it("拦截 hook 挂在 PreToolUse 上、不带 matcher（所有工具都过）", () => {
    const matchers = o.hooks?.PreToolUse ?? [];
    expect(matchers).toHaveLength(1);
    expect(matchers[0]?.matcher).toBeUndefined();
  });

  it("系统提示是 Claude Code 预设 + 宿主规则追加，写明出片由宿主负责与工作目录", () => {
    const sp = o.systemPrompt as { type: string; preset: string; append: string };
    expect(sp.type).toBe("preset");
    expect(sp.preset).toBe("claude_code");
    expect(sp.append).toContain("出片由宿主负责");
    expect(sp.append).toContain(WS);
  });

  it("花费熔断走 SDK 原生 maxBudgetUsd", () => {
    expect(o.maxBudgetUsd).toBe(5);
  });

  it("子进程不继承 NODE_OPTIONS", () => {
    expect(o.env?.NODE_OPTIONS).toBe("");
  });

  it("续会话与指定模型按需带上", () => {
    const r = build({ resume: "sess-1", model: "claude-opus-5" });
    expect(r.resume).toBe("sess-1");
    expect(r.model).toBe("claude-opus-5");
    expect(build().resume).toBeUndefined();
  });
});

describe("assertSessionOptions：不合法的配置不许启动", () => {
  const good = (): Options => build();

  it("只禁 Bash 的老配置判不合法（Phase 0 实测会被子 Agent 绕开，且拿走完整能力）", () => {
    const bad = { ...good(), disallowedTools: ["Bash"] };
    expect(() => assertSessionOptions(bad)).toThrow(/必须含 Agent[\s\S]*必须含 Task[\s\S]*不能禁 Bash/);
  });

  it("漏禁 Agent（只写了旧名 Task）：不合法", () => {
    expect(() => assertSessionOptions({ ...good(), disallowedTools: ["Task"] })).toThrow(/必须含 Agent/);
  });

  it("没挂拦截 hook：不合法", () => {
    expect(() => assertSessionOptions({ ...good(), hooks: {} })).toThrow(/PreToolUse 拦截 hook/);
  });

  it("拦截 hook 带了 matcher（只管部分工具）：不合法", () => {
    const hook: HookCallback = async () => ({});
    expect(() =>
      assertSessionOptions({ ...good(), hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] } }),
    ).toThrow(/PreToolUse 拦截 hook/);
  });

  it("继承用户设置：不合法", () => {
    expect(() => assertSessionOptions({ ...good(), settingSources: ["user", "project"] })).toThrow(/settingSources/);
  });

  it("没有花费上限：不合法", () => {
    const { maxBudgetUsd: _drop, ...rest } = good();
    expect(() => assertSessionOptions(rest)).toThrow(/maxBudgetUsd/);
  });
});

describe("guardHook", () => {
  const signal = new AbortController().signal;
  const call = (hook: HookCallback, tool: string, input: unknown, agentId?: string) =>
    hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: input,
        tool_use_id: "tu1",
        session_id: "s1",
        transcript_path: "",
        cwd: WS,
        ...(agentId ? { agent_id: agentId } : {}),
      },
      "tu1",
      { signal },
    );

  it("命中就拒绝，理由给模型看，并记一条宿主拦截日志（带子 Agent id）", async () => {
    const onIntercept = vi.fn();
    const out = await call(
      guardHook({ workspace: WS }, onIntercept),
      "Bash",
      { command: "hypit build a.svrun" },
      "sub-1",
    );
    expect(out).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(onIntercept).toHaveBeenCalledWith(
      expect.objectContaining({ rule: "hypit-command", tool: "Bash", agentId: "sub-1" }),
    );
  });

  it("拦截日志写不进去（onIntercept 抛）：仍然拒绝——日志丢一条也不能放过 build（复审 S1-H3）", async () => {
    const out = await call(
      guardHook({ workspace: WS }, () => {
        throw new Error("database is locked");
      }),
      "Bash",
      { command: "hypit build a.svrun" },
    );
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("判断本身抛（路径里有 NUL 之类）：一律拒绝，不放行（fail closed）", async () => {
    const onIntercept = vi.fn();
    const out = await call(guardHook({ workspace: WS }, onIntercept), "Write", { file_path: "a\u0000b.txt" });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(onIntercept).toHaveBeenCalledTimes(1);
  });

  it("不命中放行，不记日志", async () => {
    const onIntercept = vi.fn();
    expect(await call(guardHook({ workspace: WS }, onIntercept), "Bash", { command: "hypit check a.svml" })).toEqual(
      {},
    );
    expect(onIntercept).not.toHaveBeenCalled();
  });
});

describe("agentEnv：key 不进 Agent 进程环境（Spec §8，复审 S1-H2）", () => {
  const parent = {
    PATH: "C:/bin",
    TOKENDANCE_API_KEY: "td-secret",
    HYPIHUB_TOKEN: "hh-secret",
    MINIMAX_API_KEY: "mm-secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    ANTHROPIC_AUTH_TOKEN: "oauth-secret",
    NODE_OPTIONS: "--inspect",
    minimax_api_key: "lower-secret",
    // 复审 S1-H7：用户 shell 里挂着的别家 key（本机实测就有前两个）
    ELEVENLABS_API_KEY: "el-secret",
    FISH_API_KEY: "fish-secret",
    OPENAI_API_KEY: "oa-secret",
    FAL_KEY: "fal-secret",
    CLAUDE_CODE_MESSAGING_TOKEN: "msg-secret",
    HYPIT_REGISTRY_TOKEN: "reg-secret",
    HYPIT_HOME: "D:/hypit-home",
    HYPIT_STATE_HOME: "D:/hypit-state",
    LC_ALL: "zh_CN.UTF-8",
    SystemRoot: "C:/Windows",
    UNRELATED_TOOL_URL: "https://x",
  };

  it("只带放行名单里的变量：任何一家的 key 与 Anthropic 凭据都进不来", () => {
    const env = agentEnv(parent);
    expect(env.PATH).toBe("C:/bin");
    for (const name of [
      "TOKENDANCE_API_KEY",
      "HYPIHUB_TOKEN",
      "MINIMAX_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ]) {
      expect(env[name]).toBeUndefined();
    }
    // Windows 环境变量不分大小写，小写写法同样剔掉
    expect(env.minimax_api_key).toBeUndefined();
    expect(env.NODE_OPTIONS).toBe("");
    expect(JSON.stringify(env)).not.toContain("secret");
    // 放行名单：系统变量与 LC_* 留下，别的一律不带（HYPIT_* 也不带，复审 L5）
    expect(env.SystemRoot).toBe("C:/Windows");
    expect(env.LC_ALL).toBe("zh_CN.UTF-8");
    expect(env.HYPIT_HOME).toBeUndefined();
    // 唯一单列的 hypit 变量：状态根要和宿主一致（复审第五轮 S1-M12）
    expect(env.HYPIT_STATE_HOME).toBe("D:/hypit-state");
    expect(env.UNRELATED_TOOL_URL).toBeUndefined();
  });

  it("会话配置用的就是它：父进程带着 key 时，会话 env 里没有", () => {
    process.env.MINIMAX_API_KEY = "mm-secret";
    try {
      expect(build().env?.MINIMAX_API_KEY).toBeUndefined();
    } finally {
      delete process.env.MINIMAX_API_KEY;
    }
  });

  it("hypit 启动器目录放在 PATH 最前面；Windows 的 Path 键名沿用，不造第二个（复审 S1-H6）", () => {
    const env = agentEnv({ Path: "C:/bin" }, "D:/data/agent-bin");
    expect(env.Path).toBe(`D:/data/agent-bin${path.delimiter}C:/bin`);
    expect(env.PATH).toBeUndefined();
  });

  it("没有 PATH 时新建一个", () => {
    expect(agentEnv({}, "D:/data/agent-bin").PATH).toBe("D:/data/agent-bin");
  });
});
