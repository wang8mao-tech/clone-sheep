import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "./api.js";
import { archiveKeys } from "./archive.js";

/**
 * 名称类错误：就地贴在输入框下的红字（REQ-001「重名/超长在输入框下红字」）。
 * 其余错误走 toast，并带上后端原文。
 */
const INLINE_CODES = new Set(["NAME_TAKEN", "NAME_TOO_LONG", "NAME_EMPTY", "INVALID_BODY"]);

export function inlineNameError(err: unknown): string | undefined {
  if (err instanceof ApiError && err.code && INLINE_CODES.has(err.code)) return err.message;
  return undefined;
}

/**
 * 归档数据失效。
 *
 * 归档结构一动，侧栏树、客户页、模板页头的快照全都可能过期，逐个精确失效
 * 既啰嗦又容易漏，索性把这三支一起重拉——都是本机 SQLite 的小查询。
 */
export function useInvalidateArchive(): () => void {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: archiveKeys.clients });
    void qc.invalidateQueries({ queryKey: ["templates"] });
  }, [qc]);
}
