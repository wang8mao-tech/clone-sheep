import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router";
import { Button } from "../components/ui/Button.js";

/**
 * 路由兜底页。
 *
 * 挂在根路由的 errorElement 上时它会顶掉整个 <Shell/>（react-router 的机制如此），
 * 所以这里要把侧栏没了这件事说清楚，并给一条回得去的路，而不是只甩一个 404。
 */
export function RouteErrorPage({ notFound: forceNotFound = false }: { notFound?: boolean } = {}) {
  const error = useRouteError();
  const navigate = useNavigate();

  // 通配路由用的是普通渲染而不是错误边界，useRouteError 在那里恒为 undefined，
  // 不显式告诉它"这是找不到"的话，地址打错会说成"页面出错了"
  const notFound = forceNotFound || (isRouteErrorResponse(error) && error.status === 404);
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : undefined;

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      {/* 宽度写死而不是用 max-w-lg：这套 Tailwind 配置里没有 --container-* 刻度，
          max-w-lg 会解析成 16px，整列塌成一字一行。项目既有组件（弹窗 w-[420px]、
          toast w-80）也都是显式值，跟着来 */}
      <div className="flex w-[520px] max-w-full flex-col items-center gap-4 text-center">
        <p className="text-heading-md">{notFound ? "这个地址没有对应的页面" : "页面出错了"}</p>
        <p className="text-[13px] text-text-secondary">
          {notFound ? "地址可能过期了，或者对象已经被删掉。" : "可以回首页重来一次。"}
        </p>
        {detail ? (
          <pre className="max-h-40 w-full overflow-auto rounded-md border border-border bg-surface p-3 text-left font-mono text-caption whitespace-pre-wrap text-text-secondary">
            {detail}
          </pre>
        ) : null}
        <Button variant="primary" onClick={() => void navigate("/", { replace: true })}>
          回首页
        </Button>
      </div>
    </div>
  );
}
