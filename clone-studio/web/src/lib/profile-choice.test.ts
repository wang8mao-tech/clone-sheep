import { afterEach, describe, expect, it, vi } from "vitest";
import { DS, SUB } from "../test/profiles-kit.js";
import { markNonClaudeNoticeSeen, nonClaudeNoticeSeen, pickProfile, profileBlocker } from "./profile-choice.js";

/** CMP-010 的选择规则（REQ-010） */

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("pickProfile", () => {
  const blind = { ...DS, id: "blind", supportsVision: false, isDefault: true };
  it("想要的能选就用它；不能选退默认；默认不能选退第一个能选的；都不能选是 null", () => {
    expect(pickProfile([SUB, DS], null, "p-ds")).toBe("p-ds");
    expect(pickProfile([SUB, blind], "vision", "blind")).toBe("subscription");
    expect(pickProfile([{ ...SUB, isDefault: false }, blind], null, null)).toBe("blind");
    expect(pickProfile([blind], "vision", null)).toBeNull();
  });

  it("订阅档案不要 key；非订阅没 key 不能选", () => {
    expect(profileBlocker(SUB, "vision")).toBeNull();
    expect(profileBlocker({ ...DS, token: null }, null)).toBe("还没有 API key");
  });
});

describe("首次提醒的记录", () => {
  it("浏览器存储用不了：当没看过，也不抛", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(nonClaudeNoticeSeen()).toBe(false);
    expect(() => markNonClaudeNoticeSeen()).not.toThrow();
  });
});
