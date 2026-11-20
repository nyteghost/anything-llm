import { useEffect, useRef, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  CHAT_FONT_MIN,
  CHAT_FONT_MAX,
  CHAT_FONT_DEFAULT,
  readChatFontSize,
  subscribeChatFontSize,
  writeChatFontSize,
} from "@/utils/chat/textSize";

const SLIDER_ID = "nytedesk-settings-font-size";

/**
 * Chat font-size row of the chat settings menu. The submenu opens on mouse
 * hover, on click or tap, and from the keyboard (Enter, Space or ArrowLeft on
 * the row); Escape closes it and returns focus to the row. The slider is a
 * native range input, so arrow keys, Home and End adjust it; changes apply
 * live and persist. Below the md breakpoint the submenu opens inline under the
 * row, because a flyout to the left would leave a phone screen.
 */
export default function TextSizeRow() {
  const { t } = useTranslation();
  const [showSubmenu, setShowSubmenu] = useState(false);
  const [size, setSize] = useState(readChatFontSize);
  const rowRef = useRef(null);
  const sliderRef = useRef(null);
  // True after a mouse hover opened the submenu, so the click that follows
  // keeps it open instead of toggling it shut.
  const openedByHover = useRef(false);
  const label = t("chat_window.text_size_label");

  useEffect(() => subscribeChatFontSize(setSize), []);

  useEffect(() => {
    if (showSubmenu && document.activeElement === rowRef.current) {
      sliderRef.current?.focus();
    }
  }, [showSubmenu]);

  const change = (value) => setSize(writeChatFontSize(value));

  const close = () => {
    setShowSubmenu(false);
    rowRef.current?.focus();
  };

  const onRowClick = () => {
    if (openedByHover.current) {
      openedByHover.current = false;
      setShowSubmenu(true);
      return;
    }
    setShowSubmenu((open) => !open);
  };

  const onRowKeyDown = (event) => {
    if (["Enter", " ", "ArrowLeft"].includes(event.key)) {
      event.preventDefault();
      setShowSubmenu(true);
    }
  };

  const onSubmenuKeyDown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  // Close when keyboard focus leaves the row and its submenu.
  const onBlur = (event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setShowSubmenu(false);
    }
  };

  const rowState = showSubmenu
    ? "bg-zinc-700 light:bg-slate-200"
    : "hover:bg-zinc-700 light:hover:bg-slate-200";

  return (
    <div
      className="relative"
      onPointerEnter={(event) => {
        // Touch and pen taps also fire enter; only a mouse opens on hover.
        if (event.pointerType !== "mouse") return;
        openedByHover.current = true;
        setShowSubmenu(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        openedByHover.current = false;
        setShowSubmenu(false);
      }}
      onBlur={onBlur}
    >
      <button
        ref={rowRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={showSubmenu}
        aria-controls={showSubmenu ? `${SLIDER_ID}-panel` : undefined}
        onClick={onRowClick}
        onKeyDown={onRowKeyDown}
        className={`w-full border-none flex items-center justify-between px-2 py-1 rounded cursor-pointer ${rowState}`}
      >
        <span className="text-sm font-normal text-zinc-50 light:text-slate-800">
          {label}
        </span>
        <span className="flex items-center gap-x-1 text-xs text-zinc-300 light:text-slate-600">
          {size}px
          <CaretRight
            size={14}
            weight="bold"
            className="text-zinc-50 light:text-slate-800"
          />
        </span>
      </button>
      {showSubmenu && (
        <div
          id={`${SLIDER_ID}-panel`}
          className="mt-1 md:mt-0 md:absolute md:right-full md:top-0 md:-mr-2 md:pr-2"
          onKeyDown={onSubmenuKeyDown}
        >
          <div className="bg-zinc-800 light:bg-slate-50 border border-zinc-700 light:border-slate-300 rounded-lg p-3.5 w-full md:w-[190px] flex flex-col gap-2 shadow-lg">
            <label
              htmlFor={SLIDER_ID}
              className="flex justify-between text-xs text-white light:text-slate-800"
            >
              <span>{label}</span>
              <span>{size}px</span>
            </label>
            <input
              ref={sliderRef}
              id={SLIDER_ID}
              type="range"
              min={CHAT_FONT_MIN}
              max={CHAT_FONT_MAX}
              step="1"
              value={size}
              aria-valuetext={`${size} pixels`}
              onChange={(event) => change(Number(event.target.value))}
              className="w-full cursor-pointer accent-blue-500"
            />
            <div className="flex justify-between text-xs text-white light:text-slate-800">
              <span>{t("chat_window.small")}</span>
              <span>{t("chat_window.large")}</span>
            </div>
            <button
              type="button"
              onClick={() => change(CHAT_FONT_DEFAULT)}
              className="text-xs text-white light:text-slate-800 underline text-right"
            >
              {t("chat_window.normal")} ({CHAT_FONT_DEFAULT}px)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
