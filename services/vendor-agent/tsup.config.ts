import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime.ts", "src/main.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  noExternal: [
    "@uptime402/domain",
    "@uptime402/payments",
    "@uptime402/persistence",
  ],
});
