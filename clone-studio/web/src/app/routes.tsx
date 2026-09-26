import { createBrowserRouter, type RouteObject } from "react-router";
import { RouteErrorPage } from "./RouteErrorPage.js";
import { Shell } from "./Shell.js";
import { ClientPage } from "../pages/ClientPage.js";
import { HomePage } from "../pages/HomePage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import { TemplateLayout } from "../pages/TemplateLayout.js";
import { StepWorkspace } from "../pages/steps/StepWorkspace.js";

/** 路由表单独导出：测试用 createMemoryRouter 跑同一份配置，不另抄一份 */
export const routeConfig: RouteObject[] = [
  {
    path: "/",
    element: <Shell />,
    // 兜底必须挂在根上：没有它时任何一个没匹配上的地址都会让 react-router
    // 用内置错误页顶掉 <Shell/>，侧栏跟着一起消失，用户只能按浏览器后退键回来
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "clients/:clientId", element: <ClientPage /> },
      {
        path: "clients/:clientId/templates/:templateId",
        element: <TemplateLayout />,
        children: [
          // 用 :step 参数而不是五个字面量路径：布局要靠 useParams().step 判断
          // 当前在哪一步，字面量路径下那个参数永远是 undefined，会无限重定向。
          // 不给 index 元素——没带步骤时由 TemplateLayout 重定向到该去的那一步，
          // 这样「点模板进来」和「刷新」走的是同一条路径
          { path: ":step", element: <StepWorkspace /> },
        ],
      },
      { path: "*", element: <RouteErrorPage notFound /> },
    ],
  },
];

export const router = createBrowserRouter(routeConfig);
