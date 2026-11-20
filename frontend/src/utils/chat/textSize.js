// Shared chat font-size preference. Legacy small/normal/large values migrate to
// the pixel sizes AnythingLLM used for them (12, 14 and 18px).
export const CHAT_FONT_MIN = 10;
export const CHAT_FONT_MAX = 22;
export const CHAT_FONT_DEFAULT = 14;
export const CHAT_FONT_STORAGE_KEY = "anythingllm_text_size";
export const CHAT_FONT_EVENT = "textSizeChange";
export const LEGACY_CHAT_FONT_SIZES = Object.freeze({
  small: 12,
  normal: CHAT_FONT_DEFAULT,
  large: 18,
});

export function normalizeChatFontSize(value) {
  if (Object.hasOwn(LEGACY_CHAT_FONT_SIZES, value))
    return LEGACY_CHAT_FONT_SIZES[value];
  const parsed =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed)
    ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(parsed)))
    : CHAT_FONT_DEFAULT;
}

export function readChatFontSize() {
  try {
    const stored = window.localStorage.getItem(CHAT_FONT_STORAGE_KEY);
    const pixels = normalizeChatFontSize(stored);
    // Rewrite a legacy or out-of-range value once, so it stays migrated.
    if (stored !== null && stored !== String(pixels))
      window.localStorage.setItem(CHAT_FONT_STORAGE_KEY, String(pixels));
    return pixels;
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
  window.dispatchEvent(new CustomEvent(CHAT_FONT_EVENT, { detail: pixels }));
  return pixels;
}

/**
 * Calls `listener(pixels)` when the size changes in this tab (a slider) or in
 * another tab (a storage event). Returns the unsubscribe function.
 */
export function subscribeChatFontSize(listener) {
  const onLocal = (event) => listener(normalizeChatFontSize(event.detail));
  const onStorage = (event) => {
    if (event.key === CHAT_FONT_STORAGE_KEY)
      listener(normalizeChatFontSize(event.newValue));
  };
  window.addEventListener(CHAT_FONT_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHAT_FONT_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}
