import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectBrief, loadBrief } from "../src/context/brief.js";
import { describeReadResult, readProjectFile } from "../src/context/reader.js";

const envSnapshot = { ...process.env };

afterEach(() => {
  process.env = { ...envSnapshot };
});

function tempProject(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mb-home-"));
  process.env.MEETINGS_BOT_HOME = home;
  return fs.mkdtempSync(path.join(os.tmpdir(), "mb-proj-"));
}

describe("project brief", () => {
  it("respects gitignore, including negation, and keeps dotfiles the ignore file allows", async () => {
    const dir = tempProject();
    fs.writeFileSync(
      path.join(dir, ".gitignore"),
      ["node_modules", ".env", "secret/**", "!secret/keep.md", ""].join("\n"),
    );
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=secret\n");
    fs.writeFileSync(path.join(dir, ".env.example"), "TOKEN=\n");
    fs.mkdirSync(path.join(dir, "secret"), { recursive: true });
    fs.writeFileSync(path.join(dir, "secret", "hidden.md"), "hidden\n");
    fs.writeFileSync(path.join(dir, "secret", "keep.md"), "kept\n");
    fs.writeFileSync(path.join(dir, "README.md"), "# Sample\n");

    const brief = await buildProjectBrief(dir);
    expect(brief.tree).toContain(".env.example");
    expect(brief.tree).toContain("keep.md");
    expect(brief.tree).toContain("secret/");
    expect(brief.tree).toContain("README.md");
    expect(brief.tree).not.toContain("index.js");
    expect(brief.tree).not.toContain(".env\n");
    expect(brief.tree).not.toContain("hidden.md");
    expect(brief.seedText).not.toContain("TOKEN=secret");
  });

  it("caps depth at 4 and entries at 500", async () => {
    const dir = tempProject();
    fs.writeFileSync(path.join(dir, ".gitignore"), "");
    fs.mkdirSync(path.join(dir, "a", "b", "c", "d"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a", "b", "c", "ok.txt"), "ok\n");
    fs.writeFileSync(path.join(dir, "a", "b", "c", "d", "too-deep.txt"), "deep\n");
    fs.mkdirSync(path.join(dir, "many"), { recursive: true });
    for (let i = 0; i < 520; i += 1) {
      fs.writeFileSync(path.join(dir, "many", `f-${String(i).padStart(3, "0")}.txt`), "x\n");
    }
    const brief = await buildProjectBrief(dir);
    expect(brief.tree).toContain("ok.txt");
    expect(brief.tree).not.toContain("too-deep.txt");
    expect(brief.tree).toContain("f-000.txt");
    expect(brief.tree).not.toContain("f-519.txt");
    expect(brief.tree).toMatch(/tree truncated: \d+ entries/);
  });

  it("truncates the seed on a heading boundary and names the dropped files", async () => {
    const dir = tempProject();
    fs.writeFileSync(path.join(dir, ".gitignore"), "");
    fs.writeFileSync(
      path.join(dir, "README.md"),
      `# Keep\n\nThis stays.\n\n# Drop\n\nDROP_MARKER_${"x".repeat(25_000)}\n`,
    );
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), `# Only\n\n${"y".repeat(30_000)}\n`);
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "sample", private: true, scripts: { start: "node index.js" }, secretNoise: "SHOULD_NOT_LEAK" }),
    );
    const brief = await buildProjectBrief(dir);
    expect(brief.seedText).toContain("This stays.");
    expect(brief.seedText).not.toContain("DROP_MARKER_");
    expect(brief.seedText).toContain("(seed truncated: 3 files)");
    expect(brief.seedText).not.toContain("SHOULD_NOT_LEAK");
    expect(brief.totalBytes).toBe(Buffer.byteLength(brief.seedText));
  });

  it("keeps manifest name, scripts, and dependencies inside the budget", async () => {
    const dir = tempProject();
    fs.writeFileSync(path.join(dir, "README.md"), "# Hi\n");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "sample",
        private: true,
        scripts: { start: "node index.js" },
        dependencies: { "left-pad": "1.0.0" },
        secretNoise: "SHOULD_NOT_LEAK",
      }),
    );
    const brief = await buildProjectBrief(dir);
    expect(brief.seedText).toContain("sample");
    expect(brief.seedText).toContain("node index.js");
    expect(brief.seedText).toContain("left-pad");
    expect(brief.seedText).not.toContain("SHOULD_NOT_LEAK");
    expect(brief.seedText).not.toMatch(/seed truncated/);
  });

  it("reuses the cache until an mtime changes", async () => {
    const dir = tempProject();
    const home = process.env.MEETINGS_BOT_HOME ?? "";
    fs.writeFileSync(path.join(dir, "README.md"), "# Cached\n");
    const first = await buildProjectBrief(dir);
    expect(fs.existsSync(path.join(home, "cache", first.hash, "brief.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, "cache", first.hash, "brief.md"))).toBe(true);
    const second = await loadBrief(dir);
    expect(second.hash).toBe(first.hash);
    expect(second.generatedAt).toBe(first.generatedAt);

    const readme = path.join(dir, "README.md");
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(readme, future, future);
    const third = await loadBrief(dir);
    expect(third.hash).not.toBe(first.hash);
    expect(third.generatedAt).not.toBe(first.generatedAt);
  });
});

describe("readProjectFile", () => {
  it("refuses absolute paths, parent traversal, home paths, and symlink escapes", async () => {
    const dir = tempProject();
    fs.writeFileSync(path.join(dir, "README.md"), "inside\n");
    const outside = path.join(os.tmpdir(), `mb-outside-${process.pid}.txt`);
    fs.writeFileSync(outside, "secret-outside\n");
    fs.symlinkSync(outside, path.join(dir, "escape.txt"));

    for (const rel of ["/etc/passwd", "../outside", "~/secret", "escape.txt"]) {
      const result = await readProjectFile(dir, rel);
      expect(result.ok, rel).toBe(false);
      if (!result.ok) expect(result.reason).toBe("outside_root");
    }

    const ok = await readProjectFile(dir, "README.md");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(describeReadResult(ok)).toBe("README.md\n```\ninside\n\n```");
    }
    fs.unlinkSync(outside);
  });

  it("refuses binary files and truncates large text files at 100KB", async () => {
    const dir = tempProject();
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x10]));
    fs.writeFileSync(path.join(dir, "big.txt"), "a".repeat(150 * 1024));

    const binary = await readProjectFile(dir, "blob.bin");
    expect(binary).toMatchObject({ ok: false, reason: "binary" });
    expect(describeReadResult(binary)).toMatch(/binary/);

    const big = await readProjectFile(dir, "big.txt");
    expect(big.ok).toBe(true);
    if (big.ok) {
      expect(big.truncated).toBe(true);
      expect(Buffer.byteLength(big.content)).toBe(100 * 1024);
      expect(describeReadResult(big)).toContain("(truncated at 100KB)");
    }
  });
});
