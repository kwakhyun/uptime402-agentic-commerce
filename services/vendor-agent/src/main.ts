import { startVendorAgent } from "./runtime.js";

startVendorAgent().catch((error: unknown) => {
  const label = error instanceof Error ? error.name : "UnknownStartupError";
  // Never print provider URLs, secret paths, key material, or credential-bearing values.
  console.error(`vendor-agent startup failed (${label})`);
  process.exitCode = 1;
});
