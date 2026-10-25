import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import { ensureRuntimeDir } from "../config/load.js";

const DEPTH_CAP = 4;
const ENTRY_CAP = 500;
const SEED_BUDGET = 20_000;
const DOC_LINE_CAP = 200;
const DOC_FILE_CAP = 5;
const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"] as const;

export interface Brief {
  projectDir: string;
  hash: string;
  tree: string;
  seedText: string;
  totalBytes: number;
  generatedAt: string;
}

interface FileStat {
  rel: string;
  mtimeMs: number;
}

export async function buildProjectBrief(projectDir: string): Promise<Brief> {
  const resolved = await resolveProjectDir(projectDir);
  const files = await listProjectFiles(resolved);
  const hash = hashProject(resolved, files);
  const brief = assembleBrief(resolved, files, hash);
  writeCache(brief);
  return brief;
}

export async function loadBrief(projectDir: string): Promise<Brief> {
  const resolved = await resolveProjectDir(projectDir);
  const files = await listProjectFiles(resolved);
  const hash = hashProject(resolved, files);
  const cached = readCache(hash, resolved);
  if (cached) return cached;
  const brief = assembleBrief(resolved, files, hash);
  writeCache(brief);
  return brief;
}

async function resolveProjectDir(projectDir: string): Promise<string> {
  const resolved = path.resolve(projectDir);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    throw new Error(`project directory does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`project directory is not a directory: ${resolved}`);
  return resolved;
}

async function listProjectFiles(projectDir: string): Promise<FileStat[]> {
  const ig = await loadIgnore(projectDir);
  const paths = await fg("**/*", {
    cwd: projectDir,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
    deep: DEPTH_CAP,
  });
  const rels = paths
    .map((rel) => rel.split(path.sep).join("/"))
    .filter((rel) => rel.split("/").length <= DEPTH_CAP && !ig.ignores(rel))
    .sort((a, b) => a.localeCompare(b));

  const stats: FileStat[] = [];
  for (const rel of rels) {
    try {
      const stat = await fs.promises.stat(path.join(projectDir, rel));
      if (!stat.isFile()) continue;
      stats.push({ rel, mtimeMs: stat.mtimeMs });
    } catch {
      // File disappeared between the walk and the stat. Leave it out of this digest.
    }
  }
  return stats;
}

async function loadIgnore(projectDir: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(".git");
  const rootIgnore = path.join(projectDir, ".gitignore");
  if (fs.existsSync(rootIgnore)) {
    ig.add(await fs.promises.readFile(rootIgnore, "utf8"));
  }

  const nested = await fg("**/.gitignore", {
    cwd: projectDir,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    deep: DEPTH_CAP,
  });
  for (const rel of nested.map((entry) => entry.split(path.sep).join("/")).sort()) {
    if (rel === ".gitignore" || ig.ignores(rel)) continue;
    const dir = path.posix.dirname(rel);
    const raw = await fs.promises.readFile(path.join(projectDir, rel), "utf8");
    const prefixed = raw
      .split(/\r?\n/)
      .map((line) => prefixGitignoreLine(line, dir))
      .join("\n");
    ig.add(prefixed);
  }
  return ig;
}

function prefixGitignoreLine(line: string, dir: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return line;
  const negated = trimmed.startsWith("!");
  let body = (negated ? trimmed.slice(1) : trimmed).trim();
  if (body.startsWith("/")) body = body.slice(1);
  const joined = path.posix.join(dir, body);
  return negated ? `!${joined}` : joined;
}

function hashProject(projectDir: string, files: FileStat[]): string {
  const payload = [projectDir, ...files.map((file) => `${file.rel}\t${file.mtimeMs}`)].join("\n");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function assembleBrief(projectDir: string, files: FileStat[], hash: string): Brief {
  const tree = renderTree(path.basename(projectDir), files.map((file) => file.rel));
  const seedText = buildSeed(projectDir, new Set(files.map((file) => file.rel)));
  return {
    projectDir,
    hash,
    tree,
    seedText,
    totalBytes: Buffer.byteLength(seedText, "utf8"),
    generatedAt: new Date().toISOString(),
  };
}

function renderTree(rootLabel: string, rels: string[]): string {
  const shown = rels.slice(0, ENTRY_CAP);
  const omitted = rels.length - shown.length;
  interface DirNode {
    dirs: Map<string, DirNode>;
    files: string[];
  }
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const rel of shown) {
    const parts = rel.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    const base = parts[parts.length - 1];
    if (base) node.files.push(base);
  }

  const lines = [`${rootLabel}/`];
  const walk = (node: DirNode, prefix: string): void => {
    const entries: { name: string; dir?: DirNode }[] = [
      ...[...node.dirs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, dir]) => ({ name, dir })),
      ...node.files.sort((a, b) => a.localeCompare(b)).map((name) => ({ name })),
    ];
    entries.forEach((entry, index) => {
      const last = index === entries.length - 1;
      lines.push(`${prefix}${last ? "└── " : "├── "}${entry.name}${entry.dir ? "/" : ""}`);
      if (entry.dir) walk(entry.dir, prefix + (last ? "    " : "│   "));
    });
  };
  walk(root, "");
  if (omitted > 0) lines.push(`(tree truncated: ${omitted} entries)`);
  return lines.join("\n");
}

function buildSeed(projectDir: string, present: Set<string>): string {
  const pieces: { rel: string; text: string }[] = [];
  for (const rel of ["README.md", "CLAUDE.md"]) {
    if (!present.has(rel)) continue;
    pieces.push({ rel, text: readText(projectDir, rel) });
  }
  for (const rel of MANIFESTS) {
    if (!present.has(rel)) continue;
    pieces.push({ rel, text: manifestExcerpt(rel, readText(projectDir, rel)) });
  }
  const docs = [...present]
    .filter((rel) => rel.startsWith("docs/") && !rel.slice("docs/".length).includes("/") && rel.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, DOC_FILE_CAP);
  for (const rel of docs) {
    pieces.push({ rel, text: firstLines(readText(projectDir, rel), DOC_LINE_CAP) });
  }
  return fitSeed(pieces);
}

function readText(projectDir: string, rel: string): string {
  return fs.readFileSync(path.join(projectDir, rel), "utf8");
}

function firstLines(text: string, limit: number): string {
  const lines = text.split("\n");
  if (lines.length <= limit) return text;
  return lines.slice(0, limit).join("\n");
}

function manifestExcerpt(rel: string, raw: string): string {
  if (rel !== "package.json") return raw;
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    return JSON.stringify(
      {
        name: json.name,
        scripts: json.scripts ?? {},
        dependencies: json.dependencies ?? {},
        devDependencies: json.devDependencies ?? {},
      },
      null,
      2,
    );
  } catch {
    return raw;
  }
}

function fitSeed(pieces: { rel: string; text: string }[]): string {
  let remaining = SEED_BUDGET;
  const chunks: string[] = [];
  const truncated: string[] = [];
  for (const piece of pieces) {
    const header = `## ${piece.rel}\n\n`;
    const available = remaining - header.length;
    if (available <= 0) {
      truncated.push(piece.rel);
      continue;
    }
    if (piece.text.length <= available) {
      chunks.push(header + piece.text);
      remaining -= header.length + piece.text.length;
      continue;
    }
    const cut = cutAtHeading(piece.text, available);
    if (cut.length > 0) {
      chunks.push(`${header}${cut}`);
      remaining = 0;
    }
    truncated.push(piece.rel);
  }
  let seed = chunks.join("\n\n");
  if (truncated.length > 0) {
    seed += `\n\n(seed truncated: ${truncated.length} files)\n${truncated.map((rel) => `- ${rel}`).join("\n")}`;
  }
  return seed;
}

function cutAtHeading(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));

  let acc = "";
  for (const section of sections) {
    const next = acc.length === 0 ? section : `${acc}\n${section}`;
    if (next.length > maxChars) break;
    acc = next;
  }
  if (acc.length > 0) return acc;
  if (lines.some((line) => /^#{1,6}\s/.test(line))) return "";
  const slice = text.slice(0, maxChars);
  const newline = slice.lastIndexOf("\n");
  return newline > 0 ? slice.slice(0, newline) : slice;
}

function cacheDir(hash: string): string {
  return path.join(ensureRuntimeDir("cache"), hash);
}

function writeCache(brief: Brief): void {
  const dir = cacheDir(brief.hash);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`, "utf8");
  const markdown = [
    `# ${brief.projectDir}`,
    "",
    `hash: ${brief.hash}`,
    `generated: ${brief.generatedAt}`,
    "",
    "## Tree",
    "",
    "```",
    brief.tree,
    "```",
    "",
    "## Seed",
    "",
    brief.seedText,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "brief.md"), markdown, "utf8");
}

function readCache(hash: string, projectDir: string): Brief | null {
  const file = path.join(cacheDir(hash), "brief.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Brief>;
    if (parsed.hash !== hash || parsed.projectDir !== projectDir) return null;
    if (typeof parsed.tree !== "string" || typeof parsed.seedText !== "string") return null;
    if (typeof parsed.totalBytes !== "number" || typeof parsed.generatedAt !== "string") return null;
    return {
      projectDir,
      hash,
      tree: parsed.tree,
      seedText: parsed.seedText,
      totalBytes: parsed.totalBytes,
      generatedAt: parsed.generatedAt,
    };
  } catch {
    return null;
  }
}
