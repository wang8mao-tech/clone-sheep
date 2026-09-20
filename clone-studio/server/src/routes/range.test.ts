import { describe, expect, it } from "vitest";
import { parseRange } from "./range.js";

const SIZE = 1000;

describe("parseRange", () => {
  it("没给 Range 就整文件返回", () => {
    expect(parseRange(undefined, SIZE)).toBeUndefined();
  });

  it("常规区间", () => {
    expect(parseRange("bytes=0-499", SIZE)).toEqual({ start: 0, end: 499 });
    expect(parseRange("bytes=500-999", SIZE)).toEqual({ start: 500, end: 999 });
  });

  /** 播放器拖进度条最常发的就是这一种：从某处到结尾 */
  it("`bytes=100-` 是从 100 到结尾", () => {
    expect(parseRange("bytes=100-", SIZE)).toEqual({ start: 100, end: 999 });
  });

  it("`bytes=-500` 是最后 500 字节", () => {
    expect(parseRange("bytes=-500", SIZE)).toEqual({ start: 500, end: 999 });
  });

  it("后缀比文件还长时给整个文件，不给负的起点", () => {
    expect(parseRange("bytes=-99999", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("终点超出文件末尾时截到末尾", () => {
    expect(parseRange("bytes=900-99999", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("单字节区间", () => {
    expect(parseRange("bytes=0-0", SIZE)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=999-999", SIZE)).toEqual({ start: 999, end: 999 });
  });

  /** 语法对但范围不可满足，必须回 416，不能悄悄返回整个文件 */
  it("起点越界判为不可满足", () => {
    expect(parseRange("bytes=1000-", SIZE)).toBe("invalid");
    expect(parseRange("bytes=1500-1600", SIZE)).toBe("invalid");
  });

  it("终点小于起点判为不可满足", () => {
    expect(parseRange("bytes=500-100", SIZE)).toBe("invalid");
  });

  it("`bytes=-0` 判为不可满足——要最后 0 个字节没有意义", () => {
    expect(parseRange("bytes=-0", SIZE)).toBe("invalid");
  });

  it("空文件对任何区间都不可满足", () => {
    expect(parseRange("bytes=0-", 0)).toBe("invalid");
    expect(parseRange("bytes=0-0", 0)).toBe("invalid");
  });

  /** 看不懂的 Range 按规范可以忽略，当作整文件返回，而不是报错 */
  it("看不懂的写法当作没给", () => {
    for (const header of ["items=0-10", "bytes=abc-def", "bytes=", "bytes=0-1,5-6", "垃圾"]) {
      expect(parseRange(header, SIZE), header).toBeUndefined();
    }
  });

  it("两头都空当作没给", () => {
    expect(parseRange("bytes=-", SIZE)).toBeUndefined();
  });

  it("容忍前后空白", () => {
    expect(parseRange("  bytes=0-99  ", SIZE)).toEqual({ start: 0, end: 99 });
  });
});
