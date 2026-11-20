import { useEffect, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  CHAT_FONT_MIN, CHAT_FONT_MAX, CHAT_FONT_DEFAULT,
  normalizeChatFontSize, readChatFontSize, writeChatFontSize,
} from "@/utils/chat/textSize";

export default function TextSizeRow() {
  const { t } = useTranslation();
  const [showSubmenu, setShowSubmenu] = useState(false);
  const [size, setSize] = useState(readChatFontSize);

  useEffect(() => {
    const onChange = (event) => setSize(normalizeChatFontSize(event.detail));
    window.addEventListener("textSizeChange", onChange);
    return () => window.removeEventListener("textSizeChange", onChange);
  }, []);

  const change = (value) => setSize(writeChatFontSize(value));

  return (
    <div className="relative" onMouseEnter={() => setShowSubmenu(true)} onMouseLeave={() => setShowSubmenu(false)}>
      <div className={`flex items-center justify-between px-2 py-1 rounded cursor-pointer ${showSubmenu ? "bg-zinc-700 light:bg-slate-200" : "hover:bg-zinc-700 light:hover:bg-slate-200"}`}>
        <span className="text-sm font-normal text-zinc-50 light:text-slate-800">{t("chat_window.text_size_label")}</span>
        <CaretRight size={14} weight="bold" className="text-zinc-50 light:text-slate-800" />
      </div>
      {showSubmenu && (
        <div className="absolute right-full top-0 -mr-2 pr-2 pt-0">
          <div className="bg-zinc-800 light:bg-slate-50 border border-zinc-700 light:border-slate-300 rounded-lg p-3.5 w-[190px] flex flex-col gap-2 shadow-lg">
            <label htmlFor="nytedesk-settings-font-size" className="flex justify-between text-xs text-white light:text-slate-800">
              <span>{t("chat_window.text_size_label")}</span><span>{size}px</span>
            </label>
            <input id="nytedesk-settings-font-size" type="range" min={CHAT_FONT_MIN} max={CHAT_FONT_MAX} step="1" value={size}
              onChange={(event) => change(Number(event.target.value))} className="w-full cursor-pointer accent-blue-500" />
            <div className="flex justify-between text-xs text-white light:text-slate-800">
              <span>{t("chat_window.small")}</span><span>{t("chat_window.large")}</span>
            </div>
            <button type="button" onClick={() => change(CHAT_FONT_DEFAULT)}
              className="text-xs text-white light:text-slate-800 underline text-right">{t("chat_window.normal")} ({CHAT_FONT_DEFAULT}px)</button>
          </div>
        </div>
      )}
    </div>
  );
}
