// Shared chat font-size preference. Legacy small/normal/large values remain readable.
export const CHAT_FONT_MIN = 10;
export const CHAT_FONT_MAX = 22;
export const CHAT_FONT_DEFAULT = 14;
export const CHAT_FONT_STORAGE_KEY = "anythingllm_text_size";

export function normalizeChatFontSize(value) {
  if (value === "small") return 11;
  if (value === "normal") return CHAT_FONT_DEFAULT;
  if (value === "large") return 18;
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed)
    ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(parsed)))
    : CHAT_FONT_DEFAULT;
}

export function readChatFontSize() {
  try {
    return normalizeChatFontSize(window.localStorage.getItem(CHAT_FONT_STORAGE_KEY));
  } catch {
    return CHAT_FONT_DEFAULT;
  }
}

export function writeChatFontSize(value) {
  const pixels = normalizeChatFontSize(value);
  try {
    window.localStorage.setItem(CHAT_FONT_STORAGE_KEY, String(pixels));
  } catch {
    // Storage can be blocked. The change still applies for this page.
  }
  window.dispatchEvent(new CustomEvent("textSizeChange", { detail: pixels }));
  return pixels;
}
