import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { default as WorkspaceChatContainer } from "@/components/WorkspaceChat";
import Workspace from "@/models/workspace";
import { ENGINE_NAMES, muted, surface } from "./ui";

const CHAT_WORKSPACE_KEY = "nytedesk_chat_workspace";

function storedSlug() {
  try {
    return window.localStorage.getItem(CHAT_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

/**
 * AnythingLLM's own workspace chat, unchanged, inside the dashboard. It keeps
 * the workspace's LLM settings, documents, threads, agents and text size.
 */
export default function ChatPanel({
  workspaces,
  engines,
  title = "AI chat workspace",
}) {
  const [slug, setSlug] = useState(storedSlug);
  const [workspace, setWorkspace] = useState(null);
  const [loadedSlug, setLoadedSlug] = useState(null);
  const active = workspaces.find((w) => w.slug === slug)
    ? slug
    : (workspaces[0]?.slug ?? null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!active) return;
      const ws = await Workspace.bySlug(active);
      if (cancelled) return;
      if (!ws) {
        setWorkspace(null);
        setLoadedSlug(active);
        return;
      }
      const [suggestedMessages, { showAgentCommand }] = await Promise.all([
        Workspace.getSuggestedMessages(active),
        Workspace.agentCommandAvailable(active),
      ]);
      if (cancelled) return;
      setWorkspace({ ...ws, suggestedMessages, showAgentCommand });
      setLoadedSlug(active);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const choose = (value) => {
    setSlug(value);
    try {
      window.localStorage.setItem(CHAT_WORKSPACE_KEY, value);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  };

  const selection = engines?.selection;
  return (
    <section
      aria-labelledby="nd-chat-title"
      className={`${surface} flex flex-col min-h-0 min-w-0 w-full overflow-hidden`}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-white/10 light:border-slate-200">
        <h2
          id="nd-chat-title"
          className="text-sm font-semibold flex-1 min-w-[10rem]"
        >
          {title}
        </h2>
        {workspaces.length > 0 && (
          <label className="flex items-center gap-2 text-xs">
            <span className={muted}>Workspace</span>
            <select
              value={active ?? ""}
              onChange={(e) => choose(e.target.value)}
              className="h-8 rounded-md bg-zinc-800 light:bg-slate-100 border border-white/10 light:border-slate-200 px-2 text-xs"
            >
              {workspaces.map((w) => (
                <option key={w.slug} value={w.slug}>
                  {w.name || w.slug}
                </option>
              ))}
            </select>
          </label>
        )}
        <span
          className="text-xs rounded-md border border-white/10 light:border-slate-200 px-2 py-1"
          title="The coordinator engine selected in Local AI Manager. This chat answers with the workspace's own LLM setting."
        >
          {selection
            ? `Coordinator: ${ENGINE_NAMES[selection.engineId] || selection.engineId}${selection.model ? ` · ${selection.model}` : ""}`
            : "No coordinator engine selected"}
        </span>
        {active && (
          <Link
            to={`/workspace/${encodeURIComponent(active)}`}
            className="text-xs flex items-center gap-1 text-indigo-300 light:text-indigo-700 hover:underline"
          >
            Open full chat <ArrowSquareOut size={12} aria-hidden="true" />
          </Link>
        )}
      </div>
      <div className="flex-1 min-h-0 flex">
        {workspaces.length === 0 ? (
          <div className="m-auto p-6 text-center text-sm flex flex-col gap-2">
            <p>No workspace is available to you yet.</p>
            <Link
              to="/"
              className="text-indigo-300 light:text-indigo-700 underline"
            >
              Create a workspace in AnythingLLM
            </Link>
          </div>
        ) : (
          <WorkspaceChatContainer
            loading={loadedSlug !== active}
            workspace={workspace}
          />
        )}
      </div>
    </section>
  );
}
