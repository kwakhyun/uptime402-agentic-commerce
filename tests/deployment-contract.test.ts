import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Cloud Run deployment contract", () => {
  it("keeps capture mutable and final strictly replay-only", async () => {
    const { stdout, stderr } = await execFileAsync(
      "python3",
      ["deploy/render_cloudrun.py", "--check-templates"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 256_000,
      },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("deployment templates: valid");
  });
});
