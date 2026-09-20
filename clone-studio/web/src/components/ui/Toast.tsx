import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

export type ToastTone = "info" | "success" | "warning" | "danger";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** 错误原文：等宽显示，不截断（Design-Brief 6.2） */
  detail?: string;
}

interface ToastApi {
  push: (tone: ToastTone, message: string, detail?: string) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

const TONE: Record<ToastTone, string> = {
  info: "border-border",
  success: "border-success/50",
  warning: "border-warning/50",
  danger: "border-danger/50",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, detail?: string) => {
      const id = nextId.current++;
      setItems((prev) => [...prev, { id, tone, message, detail }]);
      // 带错误原文的不自动消失，用户要能看完并复制
      if (!detail) setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={[
              "elevation-overlay pointer-events-auto flex w-80 items-start gap-2 rounded-md border bg-surface p-3",
              TONE[t.tone],
            ].join(" ")}
          >
            <div className="flex-1">
              <p className="text-[13px] text-text">{t.message}</p>
              {t.detail ? (
                <pre className="mt-1 max-h-40 overflow-auto font-mono text-caption whitespace-pre-wrap text-text-secondary">
                  {t.detail}
                </pre>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => dismiss(t.id)}
              className="text-text-tertiary hover:text-text"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast 必须在 ToastProvider 内使用");
  return ctx;
}
