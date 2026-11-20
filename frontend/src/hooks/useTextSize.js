import { useState, useEffect } from "react";
import { readChatFontSize, subscribeChatFontSize } from "@/utils/chat/textSize";

export default function useTextSize() {
  const [textSizePx, setTextSizePx] = useState(readChatFontSize);

  useEffect(() => subscribeChatFontSize(setTextSizePx), []);

  // Preserve the historic hook shape for older consumers.
  return { textSize: textSizePx, textSizePx, textSizeClass: "" };
}
