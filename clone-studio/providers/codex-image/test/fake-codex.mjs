// 假 codex：测试用，按 FAKE_CODEX_MODE 模拟 `codex exec --json` 的各种结局，不发任何真实请求。
// 收到的 argv、cwd、NODE_OPTIONS、参考图内容写进 FAKE_CODEX_LOG，供断言。
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const argv = process.argv.slice(2);
const cwd = argv[argv.indexOf("-C") + 1];
const prompt = argv[argv.indexOf("--") + 1] ?? "";
const images = argv.flatMap((arg, i) => (arg === "--image" ? [argv[i + 1]] : []));
const thread = "019bd456-d3d4-70c3-90de-51d31a6c8571";
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f2a2d80000000049454e44ae426082",
  "hex",
);

if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    `${JSON.stringify({
      argv,
      cwd,
      processCwd: process.cwd(),
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      codexHome: process.env.CODEX_HOME ?? null,
      references: images.map((file) => readFileSync(file).toString("hex")),
    })}\n`,
  );
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const target = () => {
  const name = /\.\/images\/([^\s（]+?)\.png/u.exec(prompt)?.[1] ?? "missing";
  mkdirSync(path.join(cwd, "images"), { recursive: true });
  return path.join(cwd, "images", `${name}.png`);
};

emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });

switch (mode) {
  case "ok":
    writeFileSync(target(), PNG);
    emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "图已生成" } });
    emit({ type: "turn.completed", usage: { input_tokens: 87000, cached_input_tokens: 71000, output_tokens: 90 } });
    break;
  case "generated": {
    // 只生成到 $CODEX_HOME/generated_images/<thread>/，没复制
    const dir = path.join(process.env.CODEX_HOME, "generated_images", thread);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ig_0001.png"), PNG);
    emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    break;
  }
  case "reconnect":
    emit({ type: "error", message: "Reconnecting... 1/5" });
    writeFileSync(target(), PNG);
    emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    break;
  case "bignone":
    // exit 0 没出图，末段全是几百 KB 的命令输出行（Codex 读 imagegen/SKILL.md 时就会这样）
    for (let i = 0; i < 14; i += 1) {
      emit({
        type: "item.completed",
        item: { id: `item_${i}`, type: "command_execution", aggregated_output: "s".repeat(400_000) },
      });
    }
    break;
  case "none":
    emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "我没能生成图片" } });
    emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    break;
  case "empty":
    writeFileSync(target(), "");
    emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    break;
  case "notimage":
    writeFileSync(target(), "not a picture");
    emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    break;
  case "error":
    writeFileSync(target(), PNG);
    emit({ type: "error", message: "stream error: broken pipe" });
    break;
  case "turnfailed":
    emit({ type: "turn.failed", error: { message: "model response stream ended unexpectedly" } });
    break;
  case "quota":
    // Codex 订阅额度用完时的原话（不含 rate limit / quota）
    process.stderr.write("ERROR: You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM.\n");
    process.exit(1);
    break;
  case "bigexit":
    process.stderr.write(`${"panic ".repeat(200_000)}\n`);
    process.exit(2);
    break;
  case "bigquota":
    // 一行 40 KB、落在 stderr 保留的最后 64 KB 里，额度原话在行尾
    process.stderr.write(`${"details ".repeat(5_000)}You've hit your usage limit.\n`);
    process.exit(1);
    break;
  case "ratelimit":
    process.stderr.write("stream error: 429 Too Many Requests: rate limit exceeded\n");
    process.exit(1);
    break;
  case "exit2":
    process.stderr.write("fatal: something broke\n");
    process.exit(2);
    break;
  case "longline":
    process.stdout.write("x".repeat(5 * 1024 * 1024));
    setInterval(() => {}, 1000);
    break;
  case "orphanpipe": {
    // 自己马上退出，留一个继承了 stdout 的孙进程占着管道（审查 LOW-A 的复现方式）；
    // 孙进程的 cwd 放到系统临时目录，不占着用例的目录（11.4 第七轮审查 S7-M2）
    const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
      stdio: "inherit",
      detached: true,
      cwd: tmpdir(),
    });
    if (process.env.FAKE_GRANDCHILD_PID) writeFileSync(process.env.FAKE_GRANDCHILD_PID, String(grandchild.pid));
    grandchild.unref();
    process.exit(0);
    break;
  }
  case "hang":
    setInterval(() => {}, 1000);
    break;
  default:
    process.stderr.write(`unknown FAKE_CODEX_MODE ${mode}\n`);
    process.exit(3);
}
