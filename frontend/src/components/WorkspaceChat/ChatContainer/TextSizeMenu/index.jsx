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

export default function TextSizeMenu() {
  const { t } = useTranslation();
  const mode = useLoginMode();
  const [showMenu, setShowMenu] = useState(false);
  const [selectedSize, setSelectedSize] = useState(readChatFontSize);
  const menuRef = useRef(null);
  const buttonRef = useRef(null);

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

  function handleTextSizeChange(e) {
    setSelectedSize(writeChatFontSize(Number(e.target.value)));
  }

  const hasUserIcon = mode !== null;
  if (isMobile) return null;
  return (
    <div
      className={`absolute top-3 md:top-5 z-30 ${hasUserIcon ? "right-[55px] md:right-[67px]" : "right-4 md:right-6"}`}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setShowMenu(!showMenu)}
        aria-label={t("chat_window.text_size_label")}
        aria-expanded={showMenu}
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
          className="absolute right-0 top-[42px] bg-zinc-800 light:bg-white border border-zinc-700 light:border-slate-300 rounded-lg p-3 w-[230px] flex flex-col gap-2 shadow-lg"
        >
          <label
            htmlFor="nytedesk-chat-font-size"
            className="text-xs font-medium text-white light:text-slate-900 flex justify-between"
          >
            <span>{t("chat_window.text_size_label")}</span>
            <span>{selectedSize}px</span>
          </label>
          <input
            id="nytedesk-chat-font-size"
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
