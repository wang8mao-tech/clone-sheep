import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeStaleUploads, STALE_UPLOAD_MS } from "./uploads.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cs-uploads-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("purgeStaleUploads", () => {
  it("只删超过一天的，刚传的留着", () => {
    const now = Date.now();
    const old = path.join(dir, "old.mp4");
    const fresh = path.join(dir, "fresh.mp4");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    const past = (now - STALE_UPLOAD_MS - 1000) / 1000;
    utimesSync(old, past, past);

    expect(purgeStaleUploads(now, dir)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("目录不存在（从没上传过）不报错", () => {
    expect(purgeStaleUploads(Date.now(), path.join(dir, "nope"))).toBe(0);
  });
});
