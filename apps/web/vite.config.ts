import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: { main: "index.html", verify: "verify.html" },
      // Intel's quote verifier is Node-only and loads only for the online re-check (CLI).
      external: ["@phala/dcap-qvl-node"],
    },
  },
  optimizeDeps: { exclude: ["@phala/dcap-qvl-node"] },
});
