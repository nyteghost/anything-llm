import { useState, useEffect } from "react";
import { normalizeChatFontSize, readChatFontSize } from "@/utils/chat/textSize";

export default function useTextSize() {
  const [textSizePx, setTextSizePx] = useState(readChatFontSize);

  useEffect(() => {
    const handleTextSizeChange = (event) => {
      setTextSizePx(normalizeChatFontSize(event.detail));
    };
    window.addEventListener("textSizeChange", handleTextSizeChange);
    return () => window.removeEventListener("textSizeChange", handleTextSizeChange);
  }, []);

  // Preserve the historic hook shape for older consumers.
  return { textSize: textSizePx, textSizePx, textSizeClass: "" };
}
