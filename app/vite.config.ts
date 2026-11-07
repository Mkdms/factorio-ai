import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发模式读 tauri.conf.json 的 devUrl (localhost:1420); 端口占了就报错, 不悄悄换。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "localhost" },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
