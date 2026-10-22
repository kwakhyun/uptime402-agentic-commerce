import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["scripts/reissue-paid-incident.ts"], format: ["esm"], outDir: "dist/recovery-worker", clean: true,
  noExternal: ["@uptime402/domain", "@uptime402/payments", "@uptime402/persistence", "server-only"],
  esbuildOptions(options) { options.conditions = ["react-server"]; },
});
