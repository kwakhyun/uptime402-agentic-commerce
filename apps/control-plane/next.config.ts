import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(appDirectory, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  // The workspace is authored as NodeNext ESM, so source files use explicit
  // `.js` specifiers that TypeScript emits unchanged. Webpack's extension
  // aliases let the Next build resolve those specifiers to the checked-in
  // `.ts` sources without requiring prebuilt workspace packages.
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    },
  },
};

export default nextConfig;
