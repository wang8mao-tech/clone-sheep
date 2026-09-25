/**
 * 下载时的 Content-Disposition：ASCII 兜底名 + RFC 5987 的 UTF-8 名，中文名在各浏览器都对。
 * encodeURIComponent 不编 ' ( ) *，而它们不在 RFC 5987 的 attr-char 里，要手动再编一道（9.1 审查）
 */
export function attachment(fileName: string, fallback: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
