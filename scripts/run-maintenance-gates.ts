import { spawn } from "node:child_process";

const gates = [
  ["pnpm", ["run", "lint"]],
  ["pnpm", ["run", "typecheck"]],
  ["pnpm", ["run", "test"]],
  ["pnpm", ["run", "build"]],
  ["pnpm", ["audit", "--prod"]],
  ["pnpm", ["run", "audit:git"]],
  ["pnpm", ["run", "deploy:validate"]],
  ["pnpm", ["run", "portfolio:verify-deployment"]],
  ["pnpm", ["run", "docs:verify"]],
  ["pnpm", ["run", "ready:structural"]],
] as const;

for (const [command, args] of gates) {
  process.stdout.write(`\n[maintenance] ${command} ${args.join(" ")}\n`);
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exit(exitCode);
}

process.stdout.write("\nmaintenance gates: all passed\n");
