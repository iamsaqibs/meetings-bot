import type { Page } from "puppeteer";
import type { AppConfig } from "../config/schema.js";
import { logger } from "../logging/logger.js";
import type { TranscriptLine } from "../transcript/types.js";
import {
  CAPTION_KEY,
  CAPTION_ROW_HINTS,
  CC_BUTTON_LABELS,
  DEFAULT_CAPTION_LABELS,
  JSNAME_SELECTORS,
  SPEAKER_SPAN_MAX,
  isIconAlt,
} from "./selectors.js";

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<HtmlNode | string>;
}

export interface RawCaptionRow {
  id: string;
  imgAlt?: string;
  leadingSpan?: string;
  text: string;
  selfName?: string;
}

export interface CaptionMutation {
  id: string;
  speaker: string;
  text: string;
  atMs: number;
}

interface OpenRow {
  speaker: string;
  text: string;
  stableAt: number;
  emitted: boolean;
}

export class CaptionFinalizer {
  private readonly rows = new Map<string, OpenRow>();
  private speaking = false;

  constructor(
    private readonly finalizeMs: number,
    private readonly botName: string,
  ) {}

  setSpeaking(active: boolean): void {
    this.speaking = active;
  }

  /** Text must sit unchanged for finalizeMs. A new speaker closes the previous row immediately. */
  push(mutation: CaptionMutation): TranscriptLine[] {
    const finalized: TranscriptLine[] = [];
    const current = this.rows.get(mutation.id);
    if (!current || current.speaker !== mutation.speaker) {
      for (const [id, row] of this.rows) {
        if (row.emitted || row.speaker === mutation.speaker) continue;
        finalized.push(this.toLine(row));
        this.rows.delete(id);
      }
    }
    const existing = this.rows.get(mutation.id);
    if (!existing) {
      this.rows.set(mutation.id, {
        speaker: mutation.speaker,
        text: mutation.text,
        stableAt: mutation.atMs,
        emitted: false,
      });
    } else if (existing.text !== mutation.text || existing.speaker !== mutation.speaker) {
      existing.text = mutation.text;
      existing.speaker = mutation.speaker;
      existing.stableAt = mutation.atMs;
      existing.emitted = false;
    }
    return [...finalized, ...this.collect(mutation.atMs)];
  }

  collect(now: number): TranscriptLine[] {
    const finalized: TranscriptLine[] = [];
    for (const [id, row] of this.rows) {
      if (row.emitted || now - row.stableAt < this.finalizeMs) continue;
      finalized.push(this.toLine(row));
      this.rows.delete(id);
    }
    return finalized;
  }

  private toLine(row: OpenRow): TranscriptLine {
    const self = this.speaking || namesMatch(row.speaker, this.botName);
    return {
      ts: new Date(row.stableAt).toISOString(),
      speaker: row.speaker || "unknown",
      text: row.text,
      is_self: self,
      source: "caption",
    };
  }
}

export function attributeSpeaker(row: RawCaptionRow): { speaker: string; text: string } {
  const text = row.text.trim();
  if (row.imgAlt && !isIconAlt(row.imgAlt)) {
    return { speaker: row.imgAlt.trim(), text: stripPrefix(text, row.imgAlt) };
  }
  if (row.leadingSpan && row.leadingSpan.trim().length > 0 && row.leadingSpan.trim().length <= SPEAKER_SPAN_MAX) {
    return { speaker: row.leadingSpan.trim(), text: stripPrefix(text, row.leadingSpan) };
  }
  if (row.selfName && row.selfName.trim().length > 0) {
    return { speaker: row.selfName.trim(), text: stripPrefix(text, row.selfName) };
  }
  return { speaker: "unknown", text };
}

export type CaptionTier = "semantic" | "jsname" | "heuristic";

export function resolveCaptionRoot(
  root: HtmlNode,
  ariaLabels: readonly string[] = DEFAULT_CAPTION_LABELS,
): { tier: CaptionTier; node: HtmlNode } | null {
  const semantic = findNode(root, (node) => {
    return node.attrs.role === CAPTION_ROW_HINTS.region && ariaLabels.includes(node.attrs["aria-label"] ?? "");
  });
  if (semantic) return { tier: "semantic", node: semantic };

  const jsname = findNode(root, (node) => JSNAME_SELECTORS.some((name) => node.attrs.jsname === name));
  if (jsname) return { tier: "jsname", node: jsname };

  const candidates = collectNodes(root, (node) => {
    const live = node.attrs[CAPTION_ROW_HINTS.live] !== undefined || node.attrs.role === CAPTION_ROW_HINTS.region;
    const toolbar = /toolbar|meeting tools|controls/i.test(node.attrs["aria-label"] ?? "");
    return live && !toolbar;
  });
  const scored = candidates
    .map((node) => ({ node, score: scoreHeuristic(node) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  return { tier: "heuristic", node: best.node };
}

export function rowsFromContainer(container: HtmlNode): RawCaptionRow[] {
  return container.children.flatMap((child, index) => {
    if (typeof child === "string") return [];
    return [rowFromNode(child, index)];
  });
}

export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlNode[] = [root];
  const pattern = /<!--[\s\S]*?-->|<\/([A-Za-z0-9]+)>|<([A-Za-z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (const match of html.matchAll(pattern)) {
    const parent = stack[stack.length - 1];
    if (!parent) break;
    if (match[1]) {
      const name = match[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        const node = stack[i];
        if (node && node.tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (match[2]) {
      const node: HtmlNode = { tag: match[2].toLowerCase(), attrs: parseAttrs(match[3] ?? ""), children: [] };
      parent.children.push(node);
      if (!match[4] && !VOID_TAGS.has(node.tag)) stack.push(node);
      continue;
    }
    const text = decode(match[5] ?? "");
    if (text.trim().length > 0) parent.children.push(text);
  }
  return root;
}

export interface CaptionController {
  captionsOn: boolean;
  setSpeaking(active: boolean): void;
  stop(): Promise<void>;
}

export async function attachCaptions(
  page: Page,
  config: AppConfig,
  sink: (line: TranscriptLine) => void,
): Promise<CaptionController> {
  const labels = config.captions.ariaLabels;
  const finalizer = new CaptionFinalizer(config.wake.finalize_ms, config.bot_name);
  let captionsOn = false;
  try {
    await page.keyboard.press(CAPTION_KEY);
    captionsOn = true;
  } catch (err) {
    logger.warn({ err }, "caption keypress failed; trying the CC button");
  }
  if (!captionsOn) {
    const clicked = await page.evaluate(ccScript()).catch(() => false);
    captionsOn = clicked === true;
  }
  await page.evaluate(observerScript(labels)).catch((err: unknown) => {
    logger.warn({ err }, "caption observer failed to install");
  });
  if (!captionsOn) {
    logger.warn("captions could not be enabled; staying silent and recording whatever arrives");
  }

  const timer = setInterval(() => {
    void page
      .evaluate("(() => { const rows = window.__mbCaptions || []; window.__mbCaptions = []; return rows; })()")
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        const now = Date.now();
        for (const row of rows) {
          if (!isRawRow(row)) continue;
          const attributed = attributeSpeaker(row);
          for (const line of finalizer.push({
            id: row.id,
            speaker: attributed.speaker,
            text: attributed.text,
            atMs: now,
          })) {
            sink(line);
          }
        }
        for (const line of finalizer.collect(now)) sink(line);
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "caption drain failed");
      });
  }, 250);

  return {
    captionsOn,
    setSpeaking(active: boolean): void {
      finalizer.setSpeaking(active);
    },
    async stop(): Promise<void> {
      clearInterval(timer);
      for (const line of finalizer.collect(Date.now() + config.wake.finalize_ms)) sink(line);
    },
  };
}

const VOID_TAGS = new Set(["img", "br", "hr", "meta", "input"]);

function rowFromNode(node: HtmlNode, index: number): RawCaptionRow {
  const img = findNode(node, (candidate) => candidate.tag === CAPTION_ROW_HINTS.avatar && candidate.attrs.alt !== undefined);
  const span = node.children.find((child): child is HtmlNode => typeof child !== "string" && child.tag === "span");
  const self = findNode(node, (candidate) => candidate.attrs[CAPTION_ROW_HINTS.self] !== undefined);
  return {
    id: node.attrs["data-caption-id"] ?? `${index}:${textOf(node).slice(0, 24)}`,
    ...(img?.attrs.alt ? { imgAlt: img.attrs.alt } : {}),
    ...(span ? { leadingSpan: textOf(span) } : {}),
    text: textOf(node),
    ...(self?.attrs[CAPTION_ROW_HINTS.self] ? { selfName: self.attrs[CAPTION_ROW_HINTS.self] } : {}),
  };
}

function scoreHeuristic(node: HtmlNode): number {
  const avatars = collectNodes(node, (candidate) => candidate.tag === "img" && Boolean(candidate.attrs.alt));
  const realNames = avatars.filter((avatar) => !isIconAlt(avatar.attrs.alt ?? "")).length;
  const self = collectNodes(node, (candidate) => candidate.attrs[CAPTION_ROW_HINTS.self] !== undefined).length;
  return realNames * 2 + self;
}

function findNode(node: HtmlNode, pred: (candidate: HtmlNode) => boolean): HtmlNode | null {
  if (pred(node)) return node;
  for (const child of node.children) {
    if (typeof child === "string") continue;
    const found = findNode(child, pred);
    if (found) return found;
  }
  return null;
}

function collectNodes(node: HtmlNode, pred: (candidate: HtmlNode) => boolean): HtmlNode[] {
  const found: HtmlNode[] = [];
  if (pred(node)) found.push(node);
  for (const child of node.children) {
    if (typeof child === "string") continue;
    found.push(...collectNodes(child, pred));
  }
  return found;
}

function textOf(node: HtmlNode): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function stripPrefix(text: string, prefix: string): string {
  const trimmed = prefix.trim();
  if (text.toLowerCase().startsWith(trimmed.toLowerCase())) {
    return text.slice(trimmed.length).replace(/^[\s,:.-]+/, "").trim();
  }
  return text;
}

function namesMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([:@A-Za-z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'))?/g)) {
    const key = match[1];
    if (!key) continue;
    attrs[key] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}

function decode(text: string): string {
  return text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function isRawRow(value: unknown): value is RawCaptionRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RawCaptionRow>;
  return typeof row.id === "string" && typeof row.text === "string";
}

function ccScript(): string {
  const labels = JSON.stringify([...CC_BUTTON_LABELS]);
  return `(() => {
    const labels = ${labels};
    const nodes = Array.from(document.querySelectorAll("button, [role='button']"));
    const match = nodes.find((node) => {
      const text = (node.getAttribute("aria-label") || node.innerText || "").trim();
      return labels.some((label) => text === label || text.toLowerCase().includes(label.toLowerCase()));
    });
    if (!match) return false;
    match.click();
    return true;
  })()`;
}

function observerScript(ariaLabels: string[]): string {
  const bag = JSON.stringify({
    labels: ariaLabels,
    jsnames: [...JSNAME_SELECTORS],
  });
  return `(() => {
    if (window.__mbCaptionsInstalled) return true;
    window.__mbCaptionsInstalled = true;
    window.__mbCaptions = [];
    const bag = ${bag};
    const findRoot = () => {
      const regions = Array.from(document.querySelectorAll('[role="region"]'));
      const semantic = regions.find((node) => bag.labels.includes(node.getAttribute("aria-label") || ""));
      if (semantic) return semantic;
      for (const name of bag.jsnames) {
        const node = document.querySelector('[jsname="' + name + '"]');
        if (node) return node;
      }
      const live = Array.from(document.querySelectorAll("[aria-live], [role='region']")).filter((node) => {
        const label = node.getAttribute("aria-label") || "";
        return !/toolbar|controls/i.test(label);
      });
      return live.sort((a, b) => b.querySelectorAll("img[alt], [data-self-name]").length - a.querySelectorAll("img[alt], [data-self-name]").length)[0] || null;
    };
    const publish = () => {
      const root = findRoot();
      if (!root) return;
      const rows = Array.from(root.children).map((node, index) => {
        const img = node.querySelector("img[alt]");
        const span = node.querySelector("span");
        const self = node.querySelector("[data-self-name]") || (node.hasAttribute("data-self-name") ? node : null);
        return {
          id: node.getAttribute("data-caption-id") || String(index),
          imgAlt: img ? img.getAttribute("alt") || "" : "",
          leadingSpan: span ? (span.textContent || "").trim() : "",
          text: (node.textContent || "").replace(/\\s+/g, " ").trim(),
          selfName: self ? self.getAttribute("data-self-name") || "" : "",
        };
      });
      window.__mbCaptions.push(...rows);
    };
    const root = findRoot() || document.body;
    new MutationObserver(publish).observe(root, { childList: true, subtree: true, characterData: true });
    publish();
    return true;
  })()`;
}
