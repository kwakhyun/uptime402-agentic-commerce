import "server-only";
import { stat } from "node:fs/promises";

/** Small process-local cache; file replacement or modification invalidates it. Errors are never cached. */
export function createVerifiedEvidenceCache<T>(maxEntries = 4) {
  const entries = new Map<string, Promise<T>>();
  async function fingerprint(paths: readonly string[]) {
    return Promise.all(paths.map(async (path) => {
      try {
        const file = await stat(path, { bigint: true });
        return `${path}:${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${path}:missing`;
        throw error;
      }
    }));
  }
  return async (identity: string, paths: readonly string[], load: () => Promise<T>): Promise<T> => {
    const before = await fingerprint(paths);
    const key = JSON.stringify([identity, before]);
    let pending = entries.get(key);
    if (!pending) {
      pending = (async () => {
        const value = await load();
        if (JSON.stringify(await fingerprint(paths)) !== JSON.stringify(before)) throw new Error("Evidence changed while being verified");
        return value;
      })();
      entries.set(key, pending);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    }
    try {
      return structuredClone(await pending);
    } catch (error) {
      if (entries.get(key) === pending) entries.delete(key);
      throw error;
    }
  };
}
