import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cli from "./cli.js";
import { ensureWhisperX, probeWhisperX, WHISPERX_PROGRAM_DIR } from "./whisperx-service.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const ok = { json: { format: "hypit.cli-programs@1", ok: true, ready: true, programs: [] }, exitCode: 0 };

describe("ensureWhisperX", () => {
  it("服务健康：直接返回，不调 programs up（它即便服务在跑也要 18 秒）", async () => {
    const run = vi.spyOn(cli, "runHypit").mockResolvedValue(ok as never);
    const onStarting = vi.fn();
    await expect(ensureWhisperX("C:/ws", {}, { probe: async () => "up", onStarting })).resolves.toBe("already-up");
    expect(run).not.toHaveBeenCalled();
    expect(onStarting).not.toHaveBeenCalled();
  });

  it("没在跑：先通知「正在启动」，再在该工作目录里 programs up 这个端点", async () => {
    const run = vi.spyOn(cli, "runHypit").mockResolvedValue(ok as never);
    const onStarting = vi.fn();
    await expect(ensureWhisperX("C:/ws", { timeoutMs: 1234 }, { probe: async () => "down", onStarting })).resolves.toBe(
      "started",
    );
    expect(onStarting).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      ["programs", "up", "--endpoint", "whisperx.local", "--workspace", "C:/ws", "--json"],
      expect.objectContaining({ cwd: "C:/ws", timeoutMs: 1234 }),
    );
  });

  // 复审第二轮 H1：hypit 起不来时**不抛错**，是正常输出 ok:false 并以退出码 1 结束。
  // 桩必须是这个形状，桩成 reject 等于测一个不会发生的失败
  it("programs up 正常返回但 ok:false / ready:false：当失败抛出，带上 hypit 给的原因与日志路径", async () => {
    vi.spyOn(cli, "runHypit").mockResolvedValue({
      json: {
        format: "hypit.cli-programs@1",
        ok: false,
        ready: false,
        // hypit environment.ts 的真实形状：锁冲突写在 detail，stateDetail 是它自己的探测结果
        programs: [
          {
            id: "whisperx",
            state: "down",
            stateDetail: "nothing is answering at http://127.0.0.1:8765",
            detail: "another command owns this Program's preparation or lifecycle change; inspect its logs",
            logPath: "C:/Hypit/programs/x/program.log",
          },
        ],
      },
      exitCode: 1,
    } as never);
    const err = await ensureWhisperX("C:/ws", {}, { probe: async () => "down" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(cli.HypitError);
    expect((err as cli.HypitError).code).toBe("WHISPERX_NOT_READY");
    expect((err as cli.HypitError).message).toContain("another command owns this Program");
    expect((err as cli.HypitError).message).toContain("nothing is answering at");
    expect((err as cli.HypitError).message).toContain("C:/Hypit/programs/x/program.log");
    expect((err as cli.HypitError).raw).toContain('"ready": false');
  });

  it("端口被别的东西占着：不去 programs up（它只会回 unchanged），直接报占用", async () => {
    const run = vi.spyOn(cli, "runHypit").mockResolvedValue(ok as never);
    const err = await ensureWhisperX("C:/ws", {}, { probe: async () => "foreign" }).catch((e: unknown) => e);
    expect((err as cli.HypitError).code).toBe("WHISPERX_PORT_TAKEN");
    expect(run).not.toHaveBeenCalled();
  });

  it("runHypit 自己抛（超时、坏输出）：原样抛给调用方", async () => {
    vi.spyOn(cli, "runHypit").mockRejectedValue(new cli.HypitError("TIMEOUT", "超过 600s 未返回"));
    await expect(ensureWhisperX("C:/ws", {}, { probe: async () => "down" })).rejects.toThrow("超过 600s 未返回");
  });
});

describe("probeWhisperX", () => {
  const servers: http.Server[] = [];
  const rawServers: net.Server[] = [];
  const rawSockets = new Set<net.Socket>();
  afterEach(async () => {
    // 半关的连接会让 close 一直等，先全部掐掉
    for (const socket of rawSockets) socket.destroy();
    rawSockets.clear();
    await Promise.all(rawServers.splice(0).map((s) => new Promise((r) => s.close(r))));
    // 「卡住不回」那条的连接一直挂着，不先掐掉 close 会一直等
    await Promise.all(
      servers.splice(0).map((s) => {
        s.closeAllConnections();
        return new Promise((r) => s.close(r));
      }),
    );
  });

  async function serve(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as net.AddressInfo).port;
  }

  it("是 WhisperX 服务且自报健康：up", async () => {
    const port = await serve((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, protocol: "hypit.whisperx-service@1", model: "small" }));
    });
    expect(await probeWhisperX(1000, port)).toBe("up");
  });

  it("有东西在听但不是它（别的程序占着端口）：foreign", async () => {
    const port = await serve((_req, res) => res.end("<html>hello</html>"));
    expect(await probeWhisperX(1000, port)).toBe("foreign");
  });

  it("服务自报不健康：foreign", async () => {
    const port = await serve((_req, res) =>
      res.end(JSON.stringify({ ok: false, protocol: "hypit.whisperx-service@1" })),
    );
    expect(await probeWhisperX(1000, port)).toBe("foreign");
  });

  it("卡住不回：超时按 foreign 算", async () => {
    const port = await serve(() => {
      // 永不响应
    });
    expect(await probeWhisperX(200, port)).toBe("foreign");
  });

  /** 裸 TCP 监听者：模拟端口被一个不是 HTTP 服务的程序占着 */
  async function rawListener(onSocket: (socket: net.Socket) => void): Promise<number> {
    const server = net.createServer((socket) => {
      rawSockets.add(socket);
      onSocket(socket);
    });
    rawServers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as net.AddressInfo).port;
  }

  it("端口上的程序一连上就断开（ECONNRESET）：foreign，不是 down", async () => {
    const port = await rawListener((socket) => socket.destroy());
    expect(await probeWhisperX(1000, port)).toBe("foreign");
  });

  it("端口上的程序回的不是 HTTP：foreign", async () => {
    const port = await rawListener((socket) => socket.end("SSH-2.0-OpenSSH" + String.fromCharCode(13, 10)));
    expect(await probeWhisperX(1000, port)).toBe("foreign");
  });

  it("没人听：down", async () => {
    const port = await serve(() => {});
    await new Promise((r) => (servers.pop() as http.Server).close(r));
    expect(await probeWhisperX(1000, port)).toBe("down");
  });
});

describe("WHISPERX_PROGRAM_DIR", () => {
  it("与 hypit 在本机建的目录名一致", () => {
    expect(WHISPERX_PROGRAM_DIR).toBe("whisperx-whisperx.local-127.0.0.1%3A8765");
  });
});
