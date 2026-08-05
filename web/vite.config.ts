import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  resolve: {
    alias: {
      // 前后端共享类型（web/src 经 @shared 引用 src/shared）
      "@shared": new URL("../src/shared", import.meta.url).pathname,
    },
  },
  server: {
    fs: {
      // 允许 dev server 读取 web/ 之外的共享类型目录
      allow: [".."],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
