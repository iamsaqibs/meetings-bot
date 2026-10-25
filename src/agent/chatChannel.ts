import type { Page } from "puppeteer";

/** Meet chat controls. This is the only module that may contain these strings. */
export const CHAT_OPEN_LABELS = ["Chat with everyone", "Chat"] as const;
export const CHAT_INPUT_LABEL = "Send a message";
export const CHAT_SEND_LABELS = ["Send a message", "Send message"] as const;

export function chatPostScript(text: string): string {
  return `(() => {
    const openLabels = ${JSON.stringify([...CHAT_OPEN_LABELS])};
    const inputLabel = ${JSON.stringify(CHAT_INPUT_LABEL)};
    const sendLabels = ${JSON.stringify([...CHAT_SEND_LABELS])};
    const message = ${JSON.stringify(text)};
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    const labelOf = (node) => (node.getAttribute("aria-label") || node.innerText || "").trim();
    const box = Array.from(document.querySelectorAll("textarea, input, [contenteditable='true']")).find((node) => {
      const label = (node.getAttribute("aria-label") || node.getAttribute("placeholder") || "").trim();
      return label.includes(inputLabel);
    });
    if (!box) {
      const opener = buttons.find((node) => openLabels.some((label) => labelOf(node).includes(label)));
      if (opener) opener.click();
      return false;
    }
    box.focus();
    if ("value" in box) {
      box.value = message;
    } else {
      box.textContent = message;
    }
    box.dispatchEvent(new InputEvent("input", { bubbles: true, data: message }));
    const send = buttons.find((node) => sendLabels.some((label) => labelOf(node) === label));
    if (send) send.click();
    else box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`;
}

export async function postMeetChat(page: Page, text: string): Promise<void> {
  let posted = await page.evaluate(chatPostScript(text));
  if (posted !== true) {
    posted = await page.evaluate(chatPostScript(text));
  }
  if (posted !== true) {
    throw new Error("Meet chat controls were not found. Re-run with --headed and confirm the chat button is visible.");
  }
}
