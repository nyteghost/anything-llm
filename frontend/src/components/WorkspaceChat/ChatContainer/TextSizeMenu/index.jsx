import { useState, useRef, useEffect } from "react";
import { SlidersHorizontal } from "@phosphor-icons/react";
import useLoginMode from "@/hooks/useLoginMode";
import { useTranslation } from "react-i18next";
import { isMobile } from "react-device-detect";
import {
  CHAT_FONT_MIN,
  CHAT_FONT_MAX,
  CHAT_FONT_DEFAULT,
  readChatFontSize,
  subscribeChatFontSize,
  writeChatFontSize,
} from "@/utils/chat/textSize";

/**
 * Chat text-size popover: a button and a 10–22px slider that share the stored
 * preference with every other text-size control. `className` positions it
 * (default: the chat window's top-right corner); `allowOnMobile` shows it on
 * phones too. Escape closes it and returns focus to the button.
 */
export default function TextSizeMenu({
  className = null,
  allowOnMobile = false,
}) {
  const { t } = useTranslation();
  const mode = useLoginMode();
  const [showMenu, setShowMenu] = useState(false);
  const [selectedSize, setSelectedSize] = useState(readChatFontSize);
  const menuRef = useRef(null);
  const buttonRef = useRef(null);
  const sliderRef = useRef(null);

  useEffect(() => {
    if (!showMenu) return;
    function handleClickOutside(e) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target)
      )
        setShowMenu(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMenu]);

  useEffect(() => subscribeChatFontSize(setSelectedSize), []);

  useEffect(() => {
    if (showMenu) sliderRef.current?.focus();
  }, [showMenu]);

  function onKeyDown(event) {
    if (event.key !== "Escape" || !showMenu) return;
    event.stopPropagation();
    setShowMenu(false);
    buttonRef.current?.focus();
  }

  function handleTextSizeChange(e) {
    setSelectedSize(writeChatFontSize(Number(e.target.value)));
  }

  const hasUserIcon = mode !== null;
  if (isMobile && !allowOnMobile) return null;
  const position =
    className ??
    `absolute top-3 md:top-5 z-30 ${hasUserIcon ? "right-[55px] md:right-[67px]" : "right-4 md:right-6"}`;
  return (
    <div className={position} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setShowMenu(!showMenu)}
        aria-label={t("chat_window.text_size_label")}
        aria-expanded={showMenu}
        aria-haspopup="dialog"
        aria-controls={showMenu ? "nytedesk-chat-font-size-panel" : undefined}
        className={`group border-none cursor-pointer flex items-center justify-center w-[35px] h-[35px] rounded-full transition-all ${showMenu ? "bg-zinc-700 light:bg-slate-200" : "hover:bg-zinc-700 light:hover:bg-slate-200"}`}
      >
        <SlidersHorizontal
          size={18}
          className={
            showMenu
              ? "text-white light:text-slate-800"
              : "text-zinc-300 light:text-slate-600 group-hover:text-white light:group-hover:text-slate-800"
          }
        />
      </button>

      {showMenu && (
        <div
          ref={menuRef}
          id="nytedesk-chat-font-size-panel"
          role="dialog"
          aria-label={t("chat_window.text_size_label")}
          className="absolute z-50 right-0 top-[42px] bg-zinc-800 light:bg-white border border-zinc-700 light:border-slate-300 rounded-lg p-3 w-[230px] flex flex-col gap-2 shadow-lg"
        >
          <label
            htmlFor="nytedesk-chat-font-size"
            className="text-xs font-medium text-white light:text-slate-900 flex justify-between"
          >
            <span>{t("chat_window.text_size_label")}</span>
            <span>{selectedSize}px</span>
          </label>
          <input
            ref={sliderRef}
            id="nytedesk-chat-font-size"
            aria-valuetext={`${selectedSize} pixels`}
            type="range"
            min={CHAT_FONT_MIN}
            max={CHAT_FONT_MAX}
            step="1"
            value={selectedSize}
            onChange={handleTextSizeChange}
            className="w-full cursor-pointer accent-blue-500"
          />
          <div className="flex justify-between text-[11px] text-zinc-300 light:text-slate-600">
            <span>{t("chat_window.small")}</span>
            <span>{t("chat_window.large")}</span>
          </div>
          <button
            type="button"
            onClick={() =>
              setSelectedSize(writeChatFontSize(CHAT_FONT_DEFAULT))
            }
            className="self-end text-xs text-white light:text-slate-800 underline hover:opacity-70"
          >
            {t("chat_window.normal")} ({CHAT_FONT_DEFAULT}px)
          </button>
        </div>
      )}
    </div>
  );
}
