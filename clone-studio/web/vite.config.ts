import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // SSE 需要关掉缓冲，Vite 的 http-proxy 默认就是流式转发
      "/api": { target: "http://127.0.0.1:4310", changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
