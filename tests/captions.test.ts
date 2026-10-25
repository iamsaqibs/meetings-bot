import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isIconAlt, isMeetChromeText } from "../src/captions/selectors.js";
import {
  CaptionFinalizer,
  attributeSpeaker,
  parseHtml,
  resolveCaptionRoot,
  rowsFromContainer,
} from "../src/captions/source.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "captions");

function html(name: string): string {
  return fs.readFileSync(path.join(fixtures, name), "utf8");
}

describe("caption finalizer", () => {
  it("ignores Meet's own toolbar text", () => {
    expect(isMeetChromeText("Press Down Arrow to open the hover tray and Escape to close it.")).toBe(true);
    expect(isMeetChromeText("Take notes with Gemini")).toBe(true);
    expect(isMeetChromeText("Jarvis, what's the auth flow?")).toBe(false);
  });

  it("waits until the text stops changing, then emits the stable line", () => {
    const finalizer = new CaptionFinalizer(1500, "Saqib's Assistant");
    expect(finalizer.push({ id: "a", speaker: "Ada", text: "hel", atMs: 1_000 })).toEqual([]);
    expect(finalizer.push({ id: "a", speaker: "Ada", text: "hello there", atMs: 1_400 })).toEqual([]);
    expect(finalizer.collect(1_400 + 1_499)).toEqual([]);
    const done = finalizer.collect(1_400 + 1_500);
    expect(done).toHaveLength(1);
    expect(done[0]?.text).toBe("hello there");
    expect(done[0]?.speaker).toBe("Ada");
    expect(done[0]?.ts).toBe(new Date(1_400).toISOString());
    expect(done[0]?.is_self).toBe(false);
    expect(done[0]?.source).toBe("caption");
  });

  it("closes the previous speaker immediately when someone else starts", () => {
    const finalizer = new CaptionFinalizer(1500, "Saqib's Assistant");
    finalizer.push({ id: "a", speaker: "Ada", text: "still talking", atMs: 0 });
    const cut = finalizer.push({ id: "b", speaker: "Grace", text: "my turn", atMs: 200 });
    expect(cut.map((line) => line.text)).toEqual(["still talking"]);
    expect(finalizer.collect(200)).toEqual([]);
  });

  it("tags the bot's own captions and anything said while it is speaking", () => {
    const named = new CaptionFinalizer(100, "Saqib's Assistant");
    named.push({ id: "a", speaker: "saqib's assistant", text: "cookie session", atMs: 0 });
    expect(named.collect(100)[0]?.is_self).toBe(true);

    const live = new CaptionFinalizer(100, "Saqib's Assistant");
    live.setSpeaking(true);
    live.push({ id: "b", speaker: "Ada", text: "echo of the bot", atMs: 0 });
    expect(live.collect(100)[0]?.is_self).toBe(true);
    live.setSpeaking(false);
  });
});

describe("caption DOM", () => {
  it("resolves the semantic region, a jsname container, and a heuristic live region", () => {
    const semantic = resolveCaptionRoot(parseHtml(html("semantic.html")));
    expect(semantic?.tier).toBe("semantic");
    const semanticRow = rowsFromContainer(semantic?.node ?? parseHtml(""));
    expect(attributeSpeaker(semanticRow[0] ?? { id: "x", text: "" })).toEqual({
      speaker: "Ada Lovelace",
      text: "The auth flow is cookie based.",
    });

    const legacy = resolveCaptionRoot(parseHtml(html("jsname.html")));
    expect(legacy?.tier).toBe("jsname");
    expect(legacy?.node.attrs.jsname).toBe("YSxPC");
    const legacyRow = rowsFromContainer(legacy?.node ?? parseHtml(""))[0];
    expect(attributeSpeaker(legacyRow ?? { id: "x", text: "" })).toEqual({
      speaker: "Grace Hopper",
      text: "please check the readme",
    });

    const loose = resolveCaptionRoot(parseHtml(html("heuristic.html")));
    expect(loose?.tier).toBe("heuristic");
    const selfRow = rowsFromContainer(loose?.node ?? parseHtml(""))[0];
    expect(attributeSpeaker(selfRow ?? { id: "x", text: "" }).speaker).toBe("Saqib");
  });

  it("ignores icon ligatures and refuses a long leading span as a speaker name", () => {
    expect(isIconAlt("mic_off")).toBe(true);
    expect(isIconAlt("closed_caption_off")).toBe(true);
    expect(isIconAlt("Ada Lovelace")).toBe(false);
    const root = resolveCaptionRoot(parseHtml(html("prefix.html")));
    const row = rowsFromContainer(root?.node ?? parseHtml(""))[0];
    const attributed = attributeSpeaker(row ?? { id: "x", text: "" });
    expect(attributed.speaker).toBe("unknown");
    expect(attributed.text).toMatch(/whole line stays together/);
  });

  it("honors an overridden captions.ariaLabels list", () => {
    const french = parseHtml('<div role="region" aria-label="Sous-titres"><div>bonjour</div></div>');
    expect(resolveCaptionRoot(french)?.tier).toBeUndefined();
    expect(resolveCaptionRoot(french, ["Sous-titres", "字幕"])?.tier).toBe("semantic");
  });
});
