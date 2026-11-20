import { useEffect, useRef, useState } from "react";
import { TextT } from "@phosphor-icons/react";
import { Tooltip } from "react-tooltip";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import {
  CHAT_FONT_MIN,
  CHAT_FONT_MAX,
  CHAT_FONT_DEFAULT,
  normalizeChatFontSize,
  readChatFontSize,
  writeChatFontSize,
} from "@/utils/chat/textSize";

export default function TextSizeButton() {
  const tooltipRef = useRef(null);
  const { t } = useTranslation();
  const { theme } = useTheme();
  const toggleTooltip = () => {
    if (!tooltipRef.current) return;
    tooltipRef.current.isOpen
      ? tooltipRef.current.close()
      : tooltipRef.current.open();
  };

  return (
    <>
      <button
        type="button"
        id="text-size-btn"
        data-tooltip-id="tooltip-text-size-btn"
        aria-label={t("chat_window.text_size")}
        onClick={toggleTooltip}
        className="border-none flex justify-center items-center opacity-60 hover:opacity-100 light:opacity-100 light:hover:opacity-60 cursor-pointer"
      >
        <TextT
          color="var(--theme-sidebar-footer-icon-fill)"
          weight="fill"
          className="w-[20px] h-[20px] pointer-events-none text-white"
        />
      </button>
      <Tooltip
        ref={tooltipRef}
        id="tooltip-text-size-btn"
        place="top"
        opacity={1}
        clickable={true}
        delayShow={300}
        delayHide={800}
        arrowColor={
          theme === "light"
            ? "var(--theme-modal-border)"
            : "var(--theme-bg-primary)"
        }
        className="z-99 !w-[220px] !bg-theme-bg-primary !px-[5px] !rounded-lg !pointer-events-auto light:border-2 light:border-theme-modal-border"
      >
        <TextSizeControls />
      </Tooltip>
    </>
  );
}

function TextSizeControls() {
  const { t } = useTranslation();
  const [size, setSize] = useState(readChatFontSize);

  useEffect(() => {
    const onChange = (event) => setSize(normalizeChatFontSize(event.detail));
    window.addEventListener("textSizeChange", onChange);
    return () => window.removeEventListener("textSizeChange", onChange);
  }, []);

  const change = (value) => setSize(writeChatFontSize(value));
  return (
    <div className="flex flex-col justify-start items-stretch gap-2 p-2">
      <label
        htmlFor="nytedesk-prompt-font-size"
        className="text-xs text-theme-text-primary flex justify-between"
      >
        <span>{t("chat_window.text_size_label")}</span>
        <span>{size}px</span>
      </label>
      <input
        id="nytedesk-prompt-font-size"
        type="range"
        min={CHAT_FONT_MIN}
        max={CHAT_FONT_MAX}
        step="1"
        value={size}
        onChange={(e) => change(Number(e.target.value))}
        className="w-full cursor-pointer accent-blue-500"
      />
      <div className="flex justify-between text-xs text-theme-text-primary">
        <span>{t("chat_window.small")}</span>
        <span>{t("chat_window.large")}</span>
      </div>
      <button
        type="button"
        onClick={() => change(CHAT_FONT_DEFAULT)}
        className="self-end text-xs text-theme-text-primary underline"
      >
        {t("chat_window.normal")} ({CHAT_FONT_DEFAULT}px)
      </button>
    </div>
  );
}
