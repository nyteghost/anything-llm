import { useCallback, useEffect, useState } from "react";
import { isMobile } from "react-device-detect";
import Sidebar from "@/components/SettingsSidebar";
import CTAButton from "@/components/lib/CTAButton";
import useUser from "@/hooks/useUser";
import NyteDesk from "@/models/nytedesk";
import showToast from "@/utils/toast";

// Must match server/utils/nytedesk/control-plane.cjs. The server is the authority; these only
// populate the form.
const ADAPTERS = ["ollama", "strata", "anthropic", "openai"];
const ACTIONS = [
  "model.prompt",
  "repository.read",
  "vm.read",
  "vm.write",
  "vm.execute",
  "browser.read",
  "browser.interact",
  "git.push",
  "git.merge",
];
const STATUSES = ["", "waiting_approval", "approved", "running", "succeeded", "failed", "denied", "cancelled"];
const STATUS_STYLE = {
  waiting_approval: "bg-yellow-500/20 text-yellow-300",
  approved: "bg-sky-500/20 text-sky-300",
  running: "bg-indigo-500/20 text-indigo-300",
  succeeded: "bg-green-500/20 text-green-300",
  failed: "bg-red-500/20 text-red-300",
  denied: "bg-red-500/20 text-red-300",
  cancelled: "bg-zinc-500/20 text-zinc-300",
};

function Section({ title, description, children }) {
  return (
    <div className="w-full flex flex-col gap-y-2 py-4 border-white/10 border-b">
      <p className="text-base font-semibold text-theme-text-primary">{title}</p>
      {description && <p className="text-xs text-theme-text-secondary">{description}</p>}
      {children}
    </div>
  );
}

function StatusBadge({ status }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-mono ${STATUS_STYLE[status] || "bg-zinc-700 text-white"}`}>
      {status}
    </span>
  );
}

const short = (h) => (h ? `${h.slice(0, 12)}…` : "");
const input = "bg-theme-settings-input-bg text-white text-sm rounded-lg p-2 border border-white/10";

export default function NyteDeskDashboard() {
  const { user } = useUser();
  const [status, setStatus] = useState(null);
  const [agents, setAgents] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(null);
  const [providers, setProviders] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const s = await NyteDesk.status();
    setStatus(s.ok ? s.data : { error: s.error });
    if (!s.ok || !s.data.enabled || !s.data.multiUser) {
      setLoading(false);
      return;
    }
    const [a, w, p, t] = await Promise.all([
      NyteDesk.agents(),
      NyteDesk.workspaces(),
      NyteDesk.approvals(),
      NyteDesk.tasks({ status: filter }),
    ]);
    setAgents(a.data.agents || []);
    setWorkspaces(w.data.workspaces || []);
    setApprovals(p.data.approvals || []);
    setTasks(t.data.tasks || []);
    if (["admin", "manager"].includes(user?.role)) {
      const pr = await NyteDesk.providers();
      setProviders(pr.ok ? pr.data.providers : null);
    }
    setLoading(false);
  }, [filter, user?.role]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openTask = async (id) => {
    const r = await NyteDesk.task(id);
    if (!r.ok) return showToast(r.error, "error");
    setSelected(r.data);
  };

  const afterChange = async (id) => {
    await refresh();
    if (id) await openTask(id);
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-zinc-900 light:bg-white w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
          <div className="w-full flex flex-col gap-y-1 pb-4 border-white/10 border-b-2">
            <p className="text-lg leading-6 font-bold text-theme-text-primary">NyteDesk</p>
            <p className="text-xs leading-[18px] text-theme-text-secondary">
              Phase 1 task control plane. Tasks are proposed, reviewed and audited here. Nothing is executed:
              model, VM and browser execution is disabled in this phase.
            </p>
          </div>
          <StatusPanel status={status} loading={loading} />
          {status?.enabled && status?.multiUser && (
            <>
              <AgentsPanel agents={agents} />
              <CreateTask workspaces={workspaces} onCreated={(id) => afterChange(id)} />
              <Approvals approvals={approvals} onOpen={openTask} />
              <History tasks={tasks} filter={filter} setFilter={setFilter} onOpen={openTask} />
              {selected && (
                <TaskDetail
                  key={`${selected.task.id}-${selected.task.version}`}
                  detail={selected}
                  onClose={() => setSelected(null)}
                  onChanged={afterChange}
                />
              )}
              {providers && (
                <Providers providers={providers} isAdmin={user?.role === "admin"} onSaved={refresh} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPanel({ status, loading }) {
  if (loading) return <p className="text-sm text-theme-text-secondary py-4">Loading…</p>;
  if (!status || status.error)
    return <p className="text-sm text-red-300 py-4">NyteDesk status unavailable: {status?.error || "unknown"}</p>;
  return (
    <Section title="Status">
      <div className="flex flex-wrap gap-2 text-xs font-mono text-theme-text-primary">
        <span>enabled: {String(status.enabled)}</span>
        <span>multi-user: {String(status.multiUser)}</span>
        <span>execution: {String(!!status.executionEnabled)}</span>
        <span>browser automation: {String(!!status.browserAutomation)}</span>
        <span>VM operations: {String(!!status.vmOperations)}</span>
      </div>
      {!status.enabled && (
        <p className="text-xs text-yellow-300">NyteDesk is disabled. The server owner sets NYTEDESK_ENABLED=true to turn it on.</p>
      )}
      {status.enabled && !status.multiUser && (
        <p className="text-xs text-yellow-300">
          NyteDesk needs multi-user mode: a task must be approved by a different, authenticated user.
        </p>
      )}
    </Section>
  );
}

function AgentsPanel({ agents }) {
  return (
    <Section title="Agents" description="Model providers NyteDesk knows about. None can execute in Phase 1.">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {agents.map((a) => (
          <div key={a.id} className="rounded-lg border border-white/10 p-3 text-xs text-theme-text-primary">
            <p className="font-semibold text-sm">{a.id}</p>
            <p>configured: {a.configured ? "yes" : "no"}</p>
            <p>key present: {a.keyPresent ? "yes" : "no"}</p>
            <p>execution: disabled</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function CreateTask({ workspaces, onCreated }) {
  const [form, setForm] = useState({ slug: "", adapter: "ollama", action: "model.prompt", description: "" });
  // One key per intended task: a retry after a network error re-sends the same key, so the
  // server returns the task it already created instead of creating a second one.
  const [key, setKey] = useState(() => NyteDesk.newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => {
    setForm({ ...form, [k]: e.target.value });
    setKey(NyteDesk.newIdempotencyKey());
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!form.slug || !form.description.trim()) return showToast("Choose a workspace and describe the task", "error");
    setBusy(true);
    const r = await NyteDesk.createTask(form.slug, { description: form.description, adapter: form.adapter, action: form.action }, key);
    setBusy(false);
    if (!r.ok) return showToast(r.error, "error");
    showToast("Task submitted for approval", "success");
    setForm({ ...form, description: "" });
    setKey(NyteDesk.newIdempotencyKey());
    onCreated(r.data.task.id);
  };
  return (
    <Section title="Propose a task" description="Every action needs approval from a different manager or administrator. VM write/execute, browser interaction and git push/merge need an administrator.">
      <form onSubmit={submit} className="flex flex-col gap-2 max-w-2xl">
        <div className="flex flex-wrap gap-2">
          <select className={input} value={form.slug} onChange={set("slug")}>
            <option value="">Workspace…</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.slug}>{w.name || w.slug}</option>
            ))}
          </select>
          <select className={input} value={form.adapter} onChange={set("adapter")}>
            {ADAPTERS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select className={input} value={form.action} onChange={set("action")}>
            {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <textarea
          className={`${input} min-h-[80px]`}
          maxLength={4000}
          placeholder="Describe exactly what should be done"
          value={form.description}
          onChange={set("description")}
        />
        <div>
          <CTAButton disabled={busy} onClick={submit}>{busy ? "Submitting…" : "Submit for approval"}</CTAButton>
        </div>
      </form>
    </Section>
  );
}

function Approvals({ approvals, onOpen }) {
  return (
    <Section title={`Pending approvals (${approvals.length})`} description="Open a task to review its exact payload before deciding.">
      {approvals.length === 0 && <p className="text-xs text-theme-text-secondary">Nothing is waiting.</p>}
      {approvals.map((t) => (
        <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/10 p-2 text-xs text-theme-text-primary">
          <div className="flex flex-col min-w-0">
            <span className="font-mono">{t.action} · {t.adapter} · {t.workspaceSlug}</span>
            <span className="truncate">{t.description}</span>
          </div>
          <div className="flex gap-2 shrink-0">
            <button className="underline" onClick={() => onOpen(t.id)}>Review</button>
            {!t.canDecide && <span className="text-theme-text-secondary">not yours to decide</span>}
          </div>
        </div>
      ))}
      {/* Decisions are made only from the detail view, which shows the payload hash being approved. */}
    </Section>
  );
}

function History({ tasks, filter, setFilter, onOpen }) {
  return (
    <Section title="Task history">
      <select className={`${input} w-fit`} value={filter} onChange={(e) => setFilter(e.target.value)}>
        {STATUSES.map((s) => <option key={s} value={s}>{s || "all statuses"}</option>)}
      </select>
      <table className="w-full text-xs text-theme-text-primary">
        <thead>
          <tr className="text-left text-theme-text-secondary">
            <th className="py-1">Created</th><th>Workspace</th><th>Action</th><th>Adapter</th><th>Status</th><th>Execution</th><th />
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className="border-t border-white/5">
              <td className="py-1 font-mono">{t.createdAt}</td>
              <td>{t.workspaceSlug}</td>
              <td className="font-mono">{t.action}</td>
              <td>{t.adapter}</td>
              <td><StatusBadge status={t.status} /></td>
              <td>{t.executionEnabled ? "enabled" : "disabled"}</td>
              <td><button className="underline" onClick={() => onOpen(t.id)}>Details</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 0 && <p className="text-xs text-theme-text-secondary">No tasks.</p>}
    </Section>
  );
}

function TaskDetail({ detail, onClose, onChanged }) {
  const { task, audit, auditVerified, auditProblems, canDecide, canCancel } = detail;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per (task version, operation): double clicks and retries replay instead of repeating.
  const [keys] = useState(() => ({
    approve: NyteDesk.newIdempotencyKey(),
    deny: NyteDesk.newIdempotencyKey(),
    cancel: NyteDesk.newIdempotencyKey(),
  }));
  const act = async (op) => {
    if (op === "approve" && !window.confirm(`Approve "${task.action}" via ${task.adapter} in ${task.workspaceSlug}?\n\nPayload hash ${task.payloadHash}\n\n${task.description}`))
      return;
    setBusy(true);
    const r = op === "cancel"
      ? await NyteDesk.cancel(task, reason, keys.cancel)
      : await NyteDesk.decide(task, op, reason, keys[op]);
    setBusy(false);
    if (!r.ok) return showToast(r.error, "error");
    showToast(`Task ${r.data.task.status}`, "success");
    onChanged(task.id);
  };
  return (
    <Section title="Task detail">
      <div className="rounded-lg border border-white/10 p-3 text-xs text-theme-text-primary flex flex-col gap-1">
        <div className="flex justify-between">
          <span className="font-mono">{task.id}</span>
          <button className="underline" onClick={onClose}>Close</button>
        </div>
        <p>Status: <StatusBadge status={task.status} /> · version {task.version} · execution {task.executionEnabled ? "enabled" : "disabled"}</p>
        <p>Workspace {task.workspaceSlug} · requested by user {task.requesterId} · {task.action} via {task.adapter}</p>
        <p className="font-mono break-all">Payload hash: {task.payloadHash}</p>
        <p className="whitespace-pre-wrap border border-white/5 rounded p-2">{task.description}</p>
        {task.approval && (
          <p>
            {task.approval.decision} by user {task.approval.by} ({task.approval.role}) at {task.approval.at}
            {task.approval.expiresAt ? ` · expires ${task.approval.expiresAt}` : ""} · decision {short(task.approval.decisionId)}
          </p>
        )}
        <p className={auditVerified ? "text-green-300" : "text-red-300"}>
          Audit chain {auditVerified ? "verified" : `FAILED: ${auditProblems.join("; ")}`}
        </p>
        <ol className="font-mono">
          {audit.map((e) => (
            <li key={e.sequence}>
              {e.sequence}. {e.at} {e.event} by user {e.actorId} ({e.actorRole}) · {short(e.hash)}
            </li>
          ))}
        </ol>
        {(canDecide || canCancel) && (
          <div className="flex flex-wrap gap-2 items-center pt-2">
            <input className={input} placeholder="Reason (optional)" maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
            {canDecide && <CTAButton disabled={busy} onClick={() => act("approve")}>Approve</CTAButton>}
            {canDecide && <CTAButton disabled={busy} onClick={() => act("deny")}>Deny</CTAButton>}
            {canCancel && <CTAButton disabled={busy} onClick={() => act("cancel")}>Cancel task</CTAButton>}
          </div>
        )}
      </div>
    </Section>
  );
}

function Providers({ providers, isAdmin, onSaved }) {
  return (
    <Section
      title="Provider configuration"
      description="Endpoints and model names only. API keys are never stored by NyteDesk: name an environment variable (NYTEDESK_…) that the server owner sets. Local providers must use an IP address; Anthropic and OpenAI use their official API origins. Execution stays disabled."
    >
      {providers.map((p) => (
        <ProviderRow key={`${p.id}-${p.version}`} provider={p} isAdmin={isAdmin} onSaved={onSaved} />
      ))}
    </Section>
  );
}

function ProviderRow({ provider, isAdmin, onSaved }) {
  const [form, setForm] = useState({
    baseUrl: provider.baseUrl || "",
    model: provider.model || "",
    keyEnv: provider.keyEnv || "",
  });
  const [key] = useState(() => NyteDesk.newIdempotencyKey());
  const save = async () => {
    const body = {
      baseUrl: form.baseUrl || null,
      model: form.model || null,
      keyEnv: form.keyEnv || null,
      expectedVersion: provider.version,
    };
    const r = await NyteDesk.saveProvider(provider.id, body, key);
    if (!r.ok) return showToast(r.error, "error");
    showToast(`${provider.id} saved`, "success");
    onSaved();
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-theme-text-primary">
      <span className="w-20 font-semibold">{provider.id}</span>
      <input className={input} disabled={!isAdmin} placeholder="Base URL" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
      <input className={input} disabled={!isAdmin} placeholder="Model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
      <input className={input} disabled={!isAdmin} placeholder="NYTEDESK_… key variable" value={form.keyEnv} onChange={(e) => setForm({ ...form, keyEnv: e.target.value })} />
      <span>key present: {provider.keyPresent ? "yes" : "no"}</span>
      {isAdmin && <CTAButton onClick={save}>Save</CTAButton>}
    </div>
  );
}
