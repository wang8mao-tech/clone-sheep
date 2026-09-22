import { rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { boot, dataRoot, MP4_HEAD, multipart, uploadsLeft, type Part } from "./media-test-kit.js";

/**
 * 真实 socket 上的上传用例（复审第四、五轮）。
 *
 * inject 在响应写完那一刻就结束，看不见「请求体没读完、socket 被晾着」——
 * 只能起真端口、用裸 TCP 测。
 *
 * 判据是**服务端那条请求怎么结束的**：被放弃的请求体应当在宽限期内被排空、
 * 以 complete 收尾，连接回到 keep-alive；靠 ABANDON_GRACE_MS 的兜底 destroy
 * 才结束的，说明排空没起作用（删掉 unpipe 或 resume 都是这个结果）。
 * 先等服务端收完再 close，否则 close 撞上排空中的连接，要等 keepAliveTimeout
 * 才结束——那是测试自己制造的竞态，不是被测代码的行为（复审第五轮 MEDIUM-1）。
 */

interface RawResult {
  status: number;
  body: string;
  /** 客户端 socket 上发生过的事：end（收到 FIN）/ error:<code> / close */
  events: string[];
}

async function listen(app: FastifyInstance): Promise<{ port: number; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = [];
  app.server.on("request", (req: IncomingMessage) => requests.push(req));
  await app.listen({ host: "127.0.0.1", port: 0 });
  return { port: (app.server.address() as net.AddressInfo).port, requests };
}

/** 发一整个请求体，收到完整响应就返回，但**不主动断开** */
function sendRaw(port: number, payload: Buffer, headers: Record<string, string>): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const events: string[] = [];
    let raw = "";
    socket.on("error", (err: NodeJS.ErrnoException) => events.push(`error:${err.code ?? err.message}`));
    socket.on("end", () => events.push("end"));
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      const headEnd = raw.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(raw)?.[1] ?? "0");
      const body = raw.slice(headEnd + 4);
      if (Buffer.byteLength(body) >= length) resolve({ status: Number(raw.slice(9, 12)), body, events });
    });
    socket.on("close", () => {
      events.push("close");
      reject(new Error(`连接关了但没收到完整响应：${raw.slice(0, 200)}`));
    });
    const head = [
      "POST /api/uploads HTTP/1.1",
      "Host: 127.0.0.1",
      `Content-Length: ${payload.length}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      "",
      "",
    ].join("\r\n");
    socket.write(head);
    socket.write(payload);
  });
}

/** 等服务端这条请求结束：排空完（end）或被销毁（close），超时返回 undefined */
function serverSettled(req: IncomingMessage, ms: number): Promise<"end" | "close" | undefined> {
  if (req.readableEnded) return Promise.resolve("end");
  if (req.destroyed) return Promise.resolve("close");
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    req.once("end", () => {
      clearTimeout(timer);
      resolve("end");
    });
    req.once("close", () => {
      clearTimeout(timer);
      resolve(req.readableEnded ? "end" : "close");
    });
  });
}

async function closesWithin(close: () => Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

const BIG = Buffer.alloc(4 * 1024 * 1024, 3);
const tooManyFields = (n: number): Part[] => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, content: "x" }));

describe("POST /api/uploads · 真实 socket", () => {
  it("字段超限后还跟着大文件：回 400，剩余请求体在宽限期内排空，连接可收", async () => {
    const { app, media } = await boot();
    const { port, requests } = await listen(app);

    const body = multipart([
      ...tooManyFields(media.MAX_FIELDS + 1),
      { name: "file", filename: "a.mp4", content: Buffer.concat([MP4_HEAD, BIG]) },
    ]);
    const res = await sendRaw(port, body.payload, body.headers);
    expect(res.status).toBe(400);
    expect(res.body).toContain("TOO_MANY_FIELDS");

    // 排空而不是等兜底 destroy：必须在宽限期之内、以 end 收尾
    const req = requests[0] as IncomingMessage;
    expect(await serverSettled(req, media.ABANDON_GRACE_MS - 500)).toBe("end");
    expect(res.events).not.toContain("error:ECONNRESET");
    expect(await closesWithin(() => app.close(), 1000)).toBe(true);
    expect(uploadsLeft()).toEqual([]);
  });

  // 这条只守状态码与「不带路径」：mkdir 失败发生在 parts() 之前，请求体从没接上
  // busboy，Node 会在响应写完时自己丢弃没读的请求体（resOnFinish 里的 _dump），
  // 删掉 abandonRequest 这条照样绿。排空逻辑由上一条守（复审第六轮 LOW-1）
  it("写盘失败（UPLOAD_IO）：回 500，不带路径，连接可收", async () => {
    const { app, media } = await boot();
    // uploads 占成一个文件：mkdir 报 EEXIST / ENOTDIR，带 syscall，走 UPLOAD_IO
    rmSync(path.join(dataRoot, "uploads"), { recursive: true, force: true });
    writeFileSync(path.join(dataRoot, "uploads"), "not a dir");
    const { port, requests } = await listen(app);

    const body = multipart([{ name: "file", filename: "a.mp4", content: Buffer.concat([MP4_HEAD, BIG]) }]);
    const res = await sendRaw(port, body.payload, body.headers);
    expect(res.status).toBe(500);
    expect(res.body).toContain("UPLOAD_IO");
    expect(res.body).not.toContain(path.basename(dataRoot));

    expect(await serverSettled(requests[0] as IncomingMessage, media.ABANDON_GRACE_MS - 500)).toBe("end");
    expect(await closesWithin(() => app.close(), 1000)).toBe(true);
  });

  it("回了 400 还一直往里写的客户端：先收到 400，宽限期到了连接被掐", async () => {
    const { app, media } = await boot();
    const { port } = await listen(app);

    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    let received = "";
    socket.on("data", (chunk) => (received += chunk.toString("utf8")));
    let respondedAt = 0;
    const responded = new Promise<void>((resolve) => {
      socket.on("data", () => {
        if (!respondedAt && received.includes("\r\n\r\n")) {
          respondedAt = Date.now();
          resolve();
        }
      });
    });
    const closed = new Promise<number>((resolve) => socket.on("close", () => resolve(Date.now())));

    const boundary = "----csforever";
    socket.write(
      [
        "POST /api/uploads HTTP/1.1",
        "Host: 127.0.0.1",
        "Transfer-Encoding: chunked",
        `Content-Type: multipart/form-data; boundary=${boundary}`,
        "",
        "",
      ].join("\r\n"),
    );
    const field = (name: string): string => {
      const text = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nx\r\n`;
      return `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
    };
    for (let i = 0; i <= media.MAX_FIELDS; i++) socket.write(field(`f${i}`));
    let n = 0;
    const pump = setInterval(() => {
      if (!socket.destroyed) socket.write(field(`g${n++}`));
    }, 5);

    try {
      await responded;
      expect(received).toMatch(/^HTTP\/1\.1 400/);
      expect(received).toContain("TOO_MANY_FIELDS");
      const at = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(0), 6000))]);
      expect(at).toBeGreaterThan(0);
      // 是宽限期的兜底掐掉的，不是一收到就掐（那样客户端可能收不到 400）
      const waited = at - respondedAt;
      expect(waited).toBeGreaterThanOrEqual(media.ABANDON_GRACE_MS - 300);
      expect(waited).toBeLessThan(media.ABANDON_GRACE_MS + 2000);
    } finally {
      clearInterval(pump);
      socket.destroy();
    }
  });

  it("正常上传：请求读完，连接照常复用，不被误杀", async () => {
    const { app } = await boot();
    const { port, requests } = await listen(app);

    const body = multipart([{ name: "file", filename: "a.mp4", content: MP4_HEAD }]);
    const res = await sendRaw(port, body.payload, body.headers);
    expect(res.status).toBe(200);
    expect(await serverSettled(requests[0] as IncomingMessage, 500)).toBe("end");
    expect(res.events).toEqual([]);
  });
});
