import { createBrowserRouter, type RouteObject } from "react-router";
import { RouteErrorPage } from "./RouteErrorPage.js";
import { Shell } from "./Shell.js";
import { ClientPage } from "../pages/ClientPage.js";
import { HomePage } from "../pages/HomePage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import { TemplatePlaceholderPage } from "../pages/TemplatePlaceholderPage.js";

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
      // 模板页框架是 Task 3.4 的活。占位路由先把 FLOW-004 主路径的最后一跳接上，
      // 侧栏的选中态也才有的可依
      { path: "clients/:clientId/templates/:templateId", element: <TemplatePlaceholderPage /> },
      { path: "*", element: <RouteErrorPage notFound /> },
    ],
  },
];

export const router = createBrowserRouter(routeConfig);
