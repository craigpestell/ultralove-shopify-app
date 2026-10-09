import { build } from "vite";

await build({
  configFile: false,
  build: {
    ssr: "app/import-worker.ts",
    outDir: "build/worker",
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "worker.mjs" } },
  },
});
