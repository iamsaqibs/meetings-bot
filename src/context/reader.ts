import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 100 * 1024;

export type ReadFileFailureReason = "outside_root" | "binary" | "not_found";

export type ReadFileResult =
  | { ok: true; path: string; content: string; truncated: boolean }
  | { ok: false; path: string; reason: ReadFileFailureReason };

export async function readProjectFile(projectDir: string, relPath: string): Promise<ReadFileResult> {
  const root = path.resolve(projectDir);
  const requested = normalizeRequest(relPath);
  if (requested.startsWith("~") || requested.includes("/~")) {
    return { ok: false, path: requested, reason: "outside_root" };
  }

  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    return { ok: false, path: requested, reason: "not_found" };
  }

  const resolved = path.resolve(realRoot, requested);
  if (!isInside(realRoot, resolved)) {
    return { ok: false, path: requested, reason: "outside_root" };
  }

  let realFile: string;
  try {
    realFile = await fs.promises.realpath(resolved);
  } catch {
    return { ok: false, path: requested, reason: "not_found" };
  }
  if (!isInside(realRoot, realFile)) {
    return { ok: false, path: requested, reason: "outside_root" };
  }

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(realFile, "r");
  } catch {
    return { ok: false, path: requested, reason: "not_found" };
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, path: requested, reason: "not_found" };
    const toRead = Math.min(stat.size, MAX_BYTES + 1);
    const buf = Buffer.alloc(toRead);
    await handle.read(buf, 0, toRead, 0);
    if (isBinary(buf.subarray(0, Math.min(buf.length, 8000)))) {
      return { ok: false, path: requested, reason: "binary" };
    }
    const truncated = stat.size > MAX_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_BYTES) : buf;
    return {
      ok: true,
      path: requested,
      content: slice.toString("utf8"),
      truncated,
    };
  } finally {
    await handle.close();
  }
}

export function describeReadResult(result: ReadFileResult): string {
  if (!result.ok) {
    const where = result.path ? ` (${result.path})` : "";
    switch (result.reason) {
      case "outside_root":
        return `refused: path is outside the project root${where}`;
      case "binary":
        return `refused: file looks binary${where}`;
      case "not_found":
        return `refused: file not found${where}`;
      default: {
        const neverReason: never = result.reason;
        return neverReason;
      }
    }
  }
  const note = result.truncated ? "\n(truncated at 100KB)" : "";
  return `${result.path}\n\`\`\`\n${result.content}\n\`\`\`${note}`;
}

function normalizeRequest(relPath: string): string {
  return relPath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function isInside(root: string, candidate: string): boolean {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(rootWithSep);
}

function isBinary(sample: Buffer): boolean {
  if (sample.length === 0) return false;
  if (sample.includes(0)) return true;
  const signatures = [
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from([0x4d, 0x5a]),
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from("%PDF"),
  ];
  if (signatures.some((magic) => sample.subarray(0, magic.length).equals(magic))) return true;
  let suspicious = 0;
  for (const byte of sample) {
    const text = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    if (!text) suspicious += 1;
  }
  return suspicious / sample.length > 0.3;
}
