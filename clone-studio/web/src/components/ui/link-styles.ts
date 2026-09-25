/**
 * 长得像主按钮的链接（下载、打包下载）：原生 <a download> 让浏览器自己下载、边收边存，不走 fetch。
 * 样式对齐 Button 的 primary（components/ui/Button.tsx），改一处两边一起改
 */
export const PRIMARY_LINK_CLASS =
  "inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-on-primary hover:bg-primary-soft";
