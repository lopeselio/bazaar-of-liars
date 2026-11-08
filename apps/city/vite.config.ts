import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The city (vendor/slop-newyork) loads three@0.187 (WebGPU) from its import map. This game layer is
// built as one ES module that leaves `three` and the city's own modules external, so at runtime it
// shares the city's three instance and its road data.
export default defineConfig({
  plugins: [react()],
  // Library mode doesn't replace these; React and the wallet selector read them.
  define: { "process.env.NODE_ENV": JSON.stringify("production"), global: "globalThis" },
  build: {
    outDir: "dist/bazaar",
    emptyOutDir: true,
    target: "es2022",
    lib: { entry: "src/main.ts", formats: ["es"], fileName: () => "bazaar.js", cssFileName: "bazaar" },
    rollupOptions: { external: (id) => id === "three" || id.startsWith("three/") || id.startsWith("../js/") },
  },
});
