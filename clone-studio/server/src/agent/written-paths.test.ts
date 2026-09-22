import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writtenPaths } from "./written-paths.js";

/** writtenPaths 是纯字符串解析，不碰文件系统：路径都是假的，只看解析出的落点 */
const ws = path.resolve("/ws/clients/c/t");
const root = path.resolve("/tools/clone workflow/hypit-main");
const inRoot = (command: string) => writtenPaths(command, ws).some((p) => p.startsWith(root));

describe("writtenPaths", () => {
  it("重定向目标算写，2>&1 这类转接不算", () => {
    expect(writtenPaths("hypit check a --json > check.json 2>&1", ws)).toEqual([path.join(ws, "check.json")]);
  });

  it("popd 回到 pushd 之前的目录（复审第四轮 L1）", () => {
    expect(writtenPaths("pushd references; popd; echo {} > hypit.runtime.json", ws)).toEqual([
      path.join(ws, "hypit.runtime.json"),
    ]);
  });

  it("cd - 回到上一个目录；裸 cd 回家目录", () => {
    // 先进 hypit-main、再回工作目录、cd - 又回到 hypit-main
    expect(inRoot(`cd "${root}"; cd "${ws}"; cd -; rm -rf skills`)).toBe(true);
    expect(writtenPaths("cd && echo x > notes.txt", ws)).toEqual([path.join(homedir(), "notes.txt")]);
  });

  it("在目录里装包、改工作树的 git 子命令算写那个目录（复审第四轮 L3）", () => {
    for (const command of [
      `cd "${root}" && pnpm install`,
      `pnpm -C "${root}" install`,
      `cd "${root}" && git apply x.patch`,
      `git -C "${root}" checkout -- .`,
      `unzip a.zip -d "${root}"`,
      `dd if=a of="${root}/bin/hypit.mjs"`,
    ]) {
      expect(inRoot(command), command).toBe(true);
    }
  });

  it("只读的 git 与在工作目录里装包：不算写 hypit-main", () => {
    for (const command of ["npm install", `git -C "${root}" log -1`, `cd "${root}" && git status`]) {
      expect(inRoot(command), command).toBe(false);
    }
  });
});
