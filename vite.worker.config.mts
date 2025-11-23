import { defineConfig } from "vite";
import path from "path";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    sourcemap: true,
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, "workers/tsc/tsc_worker.ts"),
      fileName: () => "tsc_worker.js",
      formats: ["cjs"],
    },
    rollupOptions: {
      external: ["node:fs", "node:path", "node:worker_threads", "typescript"],
    },
  },
});
