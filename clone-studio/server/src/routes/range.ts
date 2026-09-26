/**
 * HTTP Range 头解析（RFC 9110 §14）。
 *
 * 只支持单段 `bytes=` —— 多段要回 multipart/byteranges，而播放器拖进度条
 * 从来只发单段。看不懂的一律当作「没给 Range」整文件返回，这是规范允许的；
 * 但**语法对、范围越界**的必须回 416，不能悄悄返回整个文件。
 */
export interface ByteRange {
  start: number;
  end: number;
}

export function parseRange(header: string | undefined, size: number): ByteRange | undefined | "invalid" {
  if (!header) return undefined;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // 语法不认的当作没给：规范说服务端可以忽略看不懂的 Range
  if (!match) return undefined;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;

  // 空文件没有任何可满足的字节范围
  if (size === 0) return "invalid";

  if (rawStart === "") {
    // `bytes=-500`：最后 500 字节。比文件还长就给整个文件
    const suffix = Number(rawEnd);
    if (suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return "invalid";

  // `bytes=100-` 表示从 100 到结尾
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "invalid";

  return { start, end };
}
