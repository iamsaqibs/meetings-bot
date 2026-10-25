/** Exact FR-8 line. Defer phrases all map to this sentence and nothing else. */
export const DEFER_LINE = "That's better answered by Saqib himself — over to you.";

export function deferTable(phrases: string[]): Array<{ phrase: string; reply: string }> {
  return phrases.map((phrase) => ({ phrase, reply: DEFER_LINE }));
}
