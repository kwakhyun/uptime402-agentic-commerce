import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createVerifiedEvidenceCache } from "../apps/control-plane/src/server/verified-evidence-cache.js";

it("deduplicates concurrent verified reads and isolates returned UI state", async () => {
  const cache = createVerifiedEvidenceCache<{ value: string }>();
  const file = join(await mkdtemp(join(tmpdir(), "u402-cache-")), "evidence.json");
  await writeFile(file, "original");
  const load = vi.fn(async () => ({ value: "verified" }));
  const [first, second] = await Promise.all([cache("pinned-hashes", [file], load), cache("pinned-hashes", [file], load)]);
  expect(load).toHaveBeenCalledTimes(1);
  first.value = "mutated";
  expect(second.value).toBe("verified");
  await writeFile(file, "replacement");
  await cache("pinned-hashes", [file], load);
  expect(load).toHaveBeenCalledTimes(2);
});

it("never caches failures or crosses evidence hash identities", async () => {
  const cache = createVerifiedEvidenceCache<string>();
  const load = vi.fn().mockRejectedValueOnce(new Error("hash mismatch")).mockResolvedValue("verified");
  await expect(cache("first-hash", [], load)).rejects.toThrow("hash mismatch");
  await expect(cache("first-hash", [], load)).resolves.toBe("verified");
  await expect(cache("second-hash", [], load)).resolves.toBe("verified");
  expect(load).toHaveBeenCalledTimes(3);
});
