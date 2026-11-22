import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  SquaresFour,
  ChatCircleText,
  Cpu,
  GitFork,
  ListChecks,
  SealCheck,
  Books,
  Brain,
  Pulse,
  GearSix,
  CaretDoubleLeft,
  CaretDoubleRight,
  MagnifyingGlass,
  ArrowsClockwise,
  List as MenuIcon,
  X,
} from "@phosphor-icons/react";
import TextSizeMenu from "@/components/WorkspaceChat/ChatContainer/TextSizeMenu";
import {
  NAV_COLLAPSED,
  NAV_EXPANDED,
  RIGHT_DEFAULT,
  RIGHT_MAX,
  RIGHT_MIN,
  clampRightWidth,
  dataFreshness,
  readLayout,
  writeLayout,
} from "@/utils/nytedesk/layout";
import { ENGINE_NAMES, muted } from "./ui";

export const SECTIONS = [
  { id: "dashboard", label: "Dashboard", icon: SquaresFour },
  { id: "workspace", label: "AI Workspace", icon: ChatCircleText },
  { id: "engines", label: "Local AI Manager", icon: Cpu },
  { id: "agentbridge", label: "AgentBridge", icon: GitFork },
  { id: "tasks", label: "Tasks & Projects", icon: ListChecks },
  { id: "approvals", label: "Approvals", icon: SealCheck },
  { id: "knowledge", label: "Knowledge Base", icon: Books },
  { id: "memories", label: "Memories", icon: Brain },
  { id: "logs", label: "Logs & Diagnostics", icon: Pulse },
  {
    id: "settings",
    label: "Settings",
    icon: GearSix,
    href: "/settings/nytedesk",
  },
];

export const sectionPath = (id) =>
  id === "dashboard" ? "/nytedesk" : `/nytedesk/${id}`;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keyboard-focusable elements inside `root`, in document order. */
export function focusableIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) => el.tabIndex !== -1 && !el.closest("[inert]")
  );
}

const isVisible = (el) =>
  !!el &&
  el.isConnected &&
  !el.closest("[inert]") &&
  el.getClientRects().length > 0;

/**
 * Focus `opener` if it is still on screen; otherwise the current page in
 * `nav`, then the first focusable control in `nav`. Never a detached node.
 */
export function restoreFocus(opener, nav) {
  if (isVisible(opener)) return opener.focus();
  const candidates = [
    nav?.querySelector('[aria-current="page"]'),
    ...focusableIn(nav),
  ];
  const target = candidates.find(isVisible);
  if (target) target.focus();
}

export function useMediaQuery(query) {
  const get = () =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(query).matches
      : false;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Layout preferences, persisted per browser. */
export function useLayout() {
  const [layout, setLayout] = useState(() => readLayout());
  const update = (patch) =>
    setLayout((prev) => writeLayout({ ...prev, ...patch }));
  return [layout, update];
}

export default function Shell({
  active,
  title,
  approvalsCount,
  engines,
  user,
  layout,
  updateLayout,
  workspaces,
  sync,
  now,
  onRefresh,
  children,
}) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const collapsed = isDesktop && layout.navCollapsed;
  const contentRef = useRef(null);
  const drawerRef = useRef(null);
  const openerRef = useRef(null);
  const desktopNavRef = useRef(null);
  const drawerModal = drawerOpen && !isDesktop;

  // Lets index.css place AnythingLLM's account button in this top bar.
  useEffect(() => {
    document.body.classList.add("nytedesk-route");
    return () => document.body.classList.remove("nytedesk-route");
  }, []);

  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  // Modal drawer: the rest of the page is inert, Tab cycles inside the drawer,
  // Escape closes it, and focus returns to the control that opened it.
  useEffect(() => {
    if (!drawerModal) return undefined;
    const background = [
      contentRef.current,
      document.querySelector("[data-user-menu]"),
    ].filter(Boolean);
    for (const el of background) {
      el.inert = true;
      el.setAttribute("aria-hidden", "true");
    }
    const focusables = () => focusableIn(drawerRef.current);
    focusables()[0]?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      const inside = drawerRef.current?.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      for (const el of background) {
        el.inert = false;
        el.removeAttribute("aria-hidden");
      }
      const opener = openerRef.current;
      openerRef.current = null;
      // After the commit that removed the drawer: return focus to the opener,
      // or, when the opener is gone (the viewport became desktop), to the
      // current page in the desktop navigation. Only if focus would be lost.
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body && document.contains(active)) {
          return;
        }
        restoreFocus(opener, desktopNavRef.current);
      });
    };
  }, [drawerModal]);

  const openDrawer = () => {
    openerRef.current = document.activeElement;
    setDrawerOpen(true);
  };

  const nav = (
    <Nav
      active={active}
      collapsed={collapsed}
      approvalsCount={approvalsCount}
      engines={engines}
      user={user}
      onToggle={
        isDesktop
          ? () => updateLayout({ navCollapsed: !layout.navCollapsed })
          : () => setDrawerOpen(false)
      }
      isDesktop={isDesktop}
      onNavigate={() => setDrawerOpen(false)}
    />
  );

  return (
    <div className="nytedesk-app w-screen h-screen overflow-hidden flex bg-zinc-950 light:bg-slate-50 text-white light:text-slate-900">
      {isDesktop && (
        <div
          ref={desktopNavRef}
          className="shrink-0 h-full transition-[width] duration-150"
          style={{ width: collapsed ? NAV_COLLAPSED : NAV_EXPANDED }}
        >
          {nav}
        </div>
      )}
      {drawerModal && (
        <div
          ref={drawerRef}
          className="fixed inset-0 z-50 flex"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <div className="h-full" style={{ width: NAV_EXPANDED }}>
            {nav}
          </div>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close navigation"
            className="flex-1 bg-black/60"
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      )}
      <div ref={contentRef} className="flex-1 min-w-0 h-full flex flex-col">
        <TopBar
          title={title}
          showMenuButton={!isDesktop}
          onMenu={openDrawer}
          workspaces={workspaces}
          sync={sync}
          now={now}
          onRefresh={onRefresh}
        />
        <main
          id="nytedesk-main"
          className="flex-1 min-h-0 overflow-auto px-3 md:px-6 pb-4"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function Nav({
  active,
  collapsed,
  approvalsCount,
  engines,
  user,
  onToggle,
  isDesktop,
  onNavigate,
}) {
  const selection = engines?.selection;
  const selectedEngine = engines?.engines?.find(
    (e) => e.id === selection?.engineId
  );
  const reachable = selectedEngine?.lastCheck?.status === "external";
  const status = [
    {
      label: "Engine",
      value: selection
        ? ENGINE_NAMES[selection.engineId] || selection.engineId
        : "None selected",
      ok: !!selection && reachable,
    },
    {
      label: "Execution",
      value: "Disabled",
      title:
        "Disabled until the VM and the other execution preconditions are verified",
      ok: false,
    },
    {
      label: "Health",
      value: !selection
        ? "No engine"
        : reachable
          ? "Engine reachable"
          : "Engine unreachable",
      ok: !!selection && reachable,
    },
  ];
  const ToggleIcon = !isDesktop
    ? X
    : collapsed
      ? CaretDoubleRight
      : CaretDoubleLeft;
  const toggleLabel = !isDesktop
    ? "Close navigation"
    : collapsed
      ? "Expand navigation"
      : "Collapse navigation";
  return (
    <nav
      aria-label="NyteDesk"
      className="h-full flex flex-col gap-2 border-r border-white/10 light:border-slate-200 bg-zinc-925 light:bg-white py-4"
    >
      <div
        className={`flex items-center ${collapsed ? "justify-center" : "justify-between px-4"} pb-3`}
      >
        {!collapsed && (
          <Link
            to="/nytedesk"
            className="flex items-center gap-2 font-semibold"
            onClick={onNavigate}
          >
            <span
              aria-hidden="true"
              className="w-7 h-7 rounded-lg bg-indigo-500/20 text-indigo-300 flex items-center justify-center"
            >
              N
            </span>
            NyteDesk
          </Link>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/5 light:hover:bg-slate-100 light:hover:text-slate-900"
        >
          <ToggleIcon size={16} />
        </button>
      </div>
      <ul className="flex flex-col gap-0.5 px-2 overflow-y-auto">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const current = s.id === active;
          const to = s.href || sectionPath(s.id);
          const count = s.id === "approvals" ? approvalsCount : 0;
          return (
            <li key={s.id}>
              <Link
                to={to}
                onClick={onNavigate}
                aria-current={current ? "page" : undefined}
                title={collapsed ? s.label : undefined}
                aria-label={
                  collapsed
                    ? count
                      ? `${s.label} (${count} pending)`
                      : s.label
                    : undefined
                }
                className={`relative flex items-center gap-3 rounded-lg ${collapsed ? "justify-center px-2" : "px-3"} py-2 text-sm ${
                  current
                    ? "bg-indigo-500/15 text-white light:text-indigo-900 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-indigo-400"
                    : "text-zinc-300 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100"
                }`}
              >
                <Icon size={18} aria-hidden="true" />
                {!collapsed && (
                  <span className="flex-1 truncate">{s.label}</span>
                )}
                {count > 0 && (
                  <span
                    aria-hidden={collapsed ? "true" : undefined}
                    className={`${collapsed ? "absolute top-0.5 right-0.5" : ""} min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-500 text-white text-[10px] flex items-center justify-center`}
                  >
                    {count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto flex flex-col gap-2 px-2">
        {!collapsed && (
          <div
            className="rounded-lg border border-white/10 light:border-slate-200 p-3 flex flex-col gap-1.5 text-xs"
            aria-label="System status"
          >
            {status.map((s) => (
              <p
                key={s.label}
                className="flex items-center gap-2"
                title={s.title}
              >
                <span
                  aria-hidden="true"
                  className={`w-2 h-2 rounded-full ${s.ok ? "bg-emerald-400" : "bg-zinc-500"}`}
                />
                <span className={muted}>{s.label}:</span>
                <span className="truncate">{s.value}</span>
              </p>
            ))}
          </div>
        )}
        {user && (
          <p
            className={`flex items-center gap-2 px-2 pt-2 text-sm ${collapsed ? "justify-center" : ""}`}
            title={collapsed ? `${user.username} (${user.role})` : undefined}
          >
            <span
              aria-hidden="true"
              className="w-7 h-7 shrink-0 rounded-full bg-zinc-700 light:bg-slate-200 flex items-center justify-center text-xs uppercase"
            >
              {(user.username || "?").slice(0, 1)}
            </span>
            {!collapsed && (
              <span className="truncate">
                {user.username} <span className={muted}>· {user.role}</span>
              </span>
            )}
          </p>
        )}
      </div>
    </nav>
  );
}

const FRESHNESS_TONE = {
  fresh: "text-zinc-400 light:text-slate-500",
  refreshing: "text-zinc-400 light:text-slate-500",
  loading: "text-zinc-400 light:text-slate-500",
  stale: "text-amber-300 light:text-amber-700",
  failed: "text-red-300 light:text-red-700",
};

const FRESHNESS_DOT = {
  fresh: "bg-emerald-400",
  refreshing: "bg-sky-400",
  loading: "bg-zinc-400",
  stale: "bg-amber-400",
  failed: "bg-red-400",
};

/**
 * When the dashboard data last loaded, and a manual refresh. Visible at every
 * width: a dot plus a short label on phones and tablets, the full sentence
 * from lg up. Screen readers get the full sentence from a polite live region.
 */
function DataFreshness({ sync, now, onRefresh }) {
  const f = dataFreshness(sync, now);
  const when = sync?.lastSuccessAt
    ? `Last successful refresh: ${sync.lastSuccessAt}`
    : "No successful refresh yet";
  return (
    <div className="flex items-center gap-1 shrink-0 min-w-0">
      <span role="status" aria-live="polite" className="sr-only">
        {`Dashboard data: ${f.label}`}
      </span>
      <span
        aria-hidden="true"
        data-freshness={f.state}
        title={`${f.label}. ${when}`}
        className={`flex items-center gap-1.5 text-xs whitespace-nowrap ${FRESHNESS_TONE[f.state]}`}
      >
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${FRESHNESS_DOT[f.state]}`}
        />
        <span className="lg:hidden" data-freshness-short>
          {f.short}
        </span>
        <span className="hidden lg:inline" data-freshness-full>
          {f.label}
        </span>
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={sync?.refreshing}
        aria-label={`Refresh dashboard data. ${f.label}`}
        title={f.label}
        className={`p-1.5 rounded-md hover:bg-white/5 light:hover:bg-slate-100 disabled:opacity-50 ${f.state === "failed" || f.state === "stale" ? FRESHNESS_TONE[f.state] : ""}`}
      >
        <ArrowsClockwise
          size={16}
          aria-hidden="true"
          className={sync?.refreshing ? "animate-spin" : ""}
        />
      </button>
    </div>
  );
}

function TopBar({
  title,
  showMenuButton,
  onMenu,
  workspaces,
  sync,
  now,
  onRefresh,
}) {
  return (
    <header className="shrink-0 flex items-center gap-2 md:gap-3 pl-3 md:pl-6 pr-16 md:pr-20 h-14 border-b border-white/10 light:border-slate-200">
      {showMenuButton && (
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open navigation"
          className="p-1.5 rounded-md hover:bg-white/5 light:hover:bg-slate-100"
        >
          <MenuIcon size={20} />
        </button>
      )}
      <h1 className="min-w-0 text-base md:text-lg font-semibold truncate">
        {title}
      </h1>
      <div className="flex-1 flex justify-center min-w-0">
        <CommandBar workspaces={workspaces} />
      </div>
      {sync && <DataFreshness sync={sync} now={now} onRefresh={onRefresh} />}
      <TextSizeMenu className="relative z-30" allowOnMobile={true} />
    </header>
  );
}

/** Jump to a section or a workspace chat. Ctrl/⌘+K focuses it. */
function CommandBar({ workspaces = [] }) {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [
      ...SECTIONS.map((s) => ({
        id: `s-${s.id}`,
        label: s.label,
        hint: "Section",
        to: s.href || sectionPath(s.id),
      })),
      ...workspaces.map((w) => ({
        id: `w-${w.slug}`,
        label: w.name || w.slug,
        hint: "Workspace chat",
        to: `/workspace/${encodeURIComponent(w.slug)}`,
      })),
    ];
    return (
      q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all
    ).slice(0, 8);
  }, [query, workspaces]);

  const go = (option) => {
    if (!option) return;
    setOpen(false);
    setQuery("");
    navigate(option.to);
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(options[index]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showList = open && options.length > 0;
  return (
    <div className="relative w-full max-w-md hidden sm:block">
      <MagnifyingGlass
        size={16}
        aria-hidden="true"
        className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
      />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls="nytedesk-command-list"
        aria-autocomplete="list"
        aria-activedescendant={
          showList ? `nytedesk-cmd-${options[index]?.id}` : undefined
        }
        aria-label="Search or jump to a section or workspace"
        placeholder="Search or jump to… (Ctrl K)"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        className="w-full h-9 rounded-lg pl-9 pr-3 text-sm bg-zinc-900 light:bg-white border border-white/10 light:border-slate-200 placeholder:text-zinc-500 outline-none focus:border-indigo-400"
      />
      {showList && (
        <ul
          id="nytedesk-command-list"
          role="listbox"
          className="absolute z-40 mt-1 w-full rounded-lg border border-white/10 light:border-slate-200 bg-zinc-900 light:bg-white shadow-xl py-1"
        >
          {options.map((o, i) => (
            <li
              key={o.id}
              id={`nytedesk-cmd-${o.id}`}
              role="option"
              aria-selected={i === index}
              onMouseDown={(e) => {
                e.preventDefault();
                go(o);
              }}
              className={`flex justify-between gap-2 px-3 py-1.5 text-sm cursor-pointer ${i === index ? "bg-indigo-500/15" : ""}`}
            >
              <span className="truncate">{o.label}</span>
              <span className={`text-xs ${muted}`}>{o.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Main panel and a right sidebar with a draggable, keyboard-operable divider.
 * The width persists; below the lg breakpoint the sidebar stacks underneath.
 */
export function ResizableSplit({ main, side, width, onWidth, sideLabel }) {
  const isWide = useMediaQuery("(min-width: 1024px)");
  const containerRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const available = () =>
    containerRef.current?.getBoundingClientRect().width ?? Infinity;
  const setWidth = (w) => onWidth(clampRightWidth(w, available()));

  if (!isWide) {
    return (
      <div className="flex flex-col gap-4">
        <div className="min-h-[60vh] flex">{main}</div>
        <aside aria-label={sideLabel} className="flex flex-col gap-4">
          {side}
        </aside>
      </div>
    );
  }

  const onPointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e) => {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setWidth(rect.right - e.clientX);
  };
  const onPointerUp = (e) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  };
  const onKeyDown = (e) => {
    const step = e.shiftKey ? 40 : 10;
    if (e.key === "ArrowLeft") setWidth(width + step);
    else if (e.key === "ArrowRight") setWidth(width - step);
    else if (e.key === "Home") setWidth(RIGHT_MAX);
    else if (e.key === "End") setWidth(RIGHT_MIN);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={containerRef}
      className={`flex h-full min-h-0 ${dragging ? "select-none cursor-col-resize" : ""}`}
    >
      <div className="flex-1 min-w-0 min-h-0 flex">{main}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${sideLabel}`}
        aria-valuemin={RIGHT_MIN}
        aria-valuemax={RIGHT_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setWidth(RIGHT_DEFAULT)}
        onKeyDown={onKeyDown}
        title="Drag, or use the arrow keys, to resize. Double-click to reset."
        className="group w-3 shrink-0 cursor-col-resize flex items-stretch justify-center outline-none"
      >
        <span className="w-px bg-white/10 light:bg-slate-200 group-hover:bg-indigo-400 group-focus-visible:bg-indigo-400 group-focus-visible:w-0.5" />
      </div>
      <aside
        aria-label={sideLabel}
        className="shrink-0 min-h-0 overflow-y-auto flex flex-col gap-4"
        style={{ width }}
      >
        {side}
      </aside>
    </div>
  );
}
