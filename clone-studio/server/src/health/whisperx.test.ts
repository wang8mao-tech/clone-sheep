import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WHISPERX_PROGRAM_DIR, type WhisperXProbe } from "../hypit/whisperx-service.js";
import { checkWhisperX, hypitStateRoot } from "./whisperx.js";

let root: string;
const WS = "D:/data/clients/c/templates/t";
const HYPIT = "D:/hypit-main";
const up = async (): Promise<WhisperXProbe> => "up";
const down = async (): Promise<WhisperXProbe> => "down";

/** 装好了 = 有 .venv/pyvenv.cfg；punkt 可选 */
function installed(withPunkt: boolean): string {
  const dir = path.join(root, "programs", WHISPERX_PROGRAM_DIR);
  mkdirSync(path.join(dir, ".venv"), { recursive: true });
  writeFileSync(path.join(dir, ".venv", "pyvenv.cfg"), "home = x");
  const punkt = path.join(dir, "nltk_data", "tokenizers", "punkt_tab", "english");
  mkdirSync(withPunkt ? punkt : path.join(dir, "nltk_data"), { recursive: true });
  if (withPunkt) writeFileSync(path.join(punkt, "collocations.tab"), "x");
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cs-whisperx-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("checkWhisperX", () => {
  it("服务在跑：pass", async () => {
    installed(true);
    const r = await checkWhisperX({ stateRoot: root, hypitRoot: HYPIT, workspace: WS, probe: up });
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("127.0.0.1:8765");
  });

  it("装好了但服务没在跑：warn 不挡路，修复命令带 --workspace（脱离工作目录跑会报 requires a Runtime）", async () => {
    installed(true);
    const r = await checkWhisperX({ stateRoot: root, hypitRoot: HYPIT, workspace: WS, probe: down });
    expect(r.status).toBe("warn");
    expect(r.blocking).toBe(false);
    expect(r.fix).toBe(
      `node "${path.join(HYPIT, "bin", "hypit.mjs")}" programs up --endpoint whisperx.local --workspace "${WS}"`,
    );
  });

  it("端口被别的程序占着或服务卡死：fail 且挡路，点明端口", async () => {
    installed(true);
    const r = await checkWhisperX({ stateRoot: root, hypitRoot: HYPIT, workspace: WS, probe: async () => "foreign" });
    expect(r.status).toBe("fail");
    expect(r.blocking).toBe(true);
    expect(r.detail).toContain("127.0.0.1:8765");
  });

  it("缺 punkt_tab：fail 且挡路，点明 SSRF 报错，解压到确切的 tokenizers 目录", async () => {
    const dir = installed(false);
    const r = await checkWhisperX({ stateRoot: root, hypitRoot: HYPIT, workspace: WS, probe: down });
    expect(r.status).toBe("fail");
    expect(r.blocking).toBe(true);
    expect(r.detail).toContain("SSRF attempt to restricted IP ::");
    expect(r.detail).toContain("PowerShell");
    expect(r.fix).toContain("punkt_tab.zip");
    expect(r.fix).toContain(path.join(dir, "nltk_data", "tokenizers"));
  });

  it("punkt_tab 目录在但是空的（解压一半）：同样算缺", async () => {
    const dir = installed(false);
    mkdirSync(path.join(dir, "nltk_data", "tokenizers", "punkt_tab"), { recursive: true });
    const r = await checkWhisperX({ stateRoot: root, hypitRoot: HYPIT, workspace: WS, probe: down });
    expect(r.status).toBe("fail");
  });

  it("没装：warn，修复命令同样带 --workspace，并预告可能撞上的 SSRF", async () => {
    const r = await checkWhisperX({ stateRoot: root, hypitRoot: HYPIT, workspace: WS, probe: down });
    expect(r.status).toBe("warn");
    expect(r.fix).toContain(`--workspace "${WS}"`);
    expect(r.detail).toContain("SSRF attempt to restricted IP ::");
  });

  it("程序目录在但没有 .venv（装到一半失败）：仍算没装，不报「已安装」", async () => {
    mkdirSync(path.join(root, "programs", WHISPERX_PROGRAM_DIR, "nltk_data"), { recursive: true });
    const r = await checkWhisperX({ stateRoot: root, hypitRoot: HYPIT, workspace: WS, probe: down });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("未安装");
  });

  it("只认 hypit 给这个端点建的那个目录，别的 whisperx-* 残留不算", async () => {
    mkdirSync(path.join(root, "programs", "whisperx-other-127.0.0.1%3A9999", "nltk_data"), { recursive: true });
    const r = await checkWhisperX({ stateRoot: root, hypitRoot: HYPIT, workspace: WS, probe: down });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("未安装");
  });

  it("还没有任何模板：不给一条跑不通的命令，说明先建模板", async () => {
    installed(true);
    const r = await checkWhisperX({ stateRoot: root, hypitRoot: HYPIT, workspace: null, probe: down });
    expect(r.fix).toBeNull();
    expect(r.detail).toContain("先新建一个模板");
  });

  it("状态目录读炸了：只坏这一行，不抛出去拖垮整个体检接口", async () => {
    installed(true);
    const r = await checkWhisperX({
      stateRoot: root,
      hypitRoot: HYPIT,
      workspace: WS,
      probe: async () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("EACCES");
  });
});

describe("hypitStateRoot", () => {
  it("HYPIT_STATE_HOME 优先", () => {
    expect(hypitStateRoot({ HYPIT_STATE_HOME: root }, "win32")).toBe(path.resolve(root));
  });

  it("Windows 落在 LOCALAPPDATA\\Hypit，与 hypit 的 runtime-host-node 一致", () => {
    expect(hypitStateRoot({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe(
      path.join("C:\\Users\\u\\AppData\\Local", "Hypit"),
    );
  });
});
