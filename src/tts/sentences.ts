/** Split spoken text on sentence boundaries. A comma does not start a new sentence. */
export function splitSentences(text: string): string[] {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  const parts = trimmed.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) ?? [];
  const sentences = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  return sentences.length > 0 ? sentences : [trimmed];
}
