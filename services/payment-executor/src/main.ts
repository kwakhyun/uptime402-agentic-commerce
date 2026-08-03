import { startPaymentExecutor } from "./runtime.js";

startPaymentExecutor().catch((error: unknown) => {
  const label = error instanceof Error ? error.name : "UnknownStartupError";
  // Do not print exception messages: they may contain secret paths or provider details.
  console.error(`payment-executor startup failed (${label})`);
  process.exitCode = 1;
});
