import { useCallback, useEffect, useState } from "react";
import { isMobile } from "react-device-detect";
import { Link } from "react-router-dom";
import Sidebar from "@/components/SettingsSidebar";
import CTAButton from "@/components/lib/CTAButton";
import useUser from "@/hooks/useUser";
import NyteDesk from "@/models/nytedesk";
import showToast from "@/utils/toast";
import LocalAIEngines from "./LocalAIEngines";

// Must match server/utils/nytedesk/control-plane.cjs. The server is the
// authority; these lists only populate the form.
const ADAPTERS = [
  "ollama",
  "strata",
  "polystrata",
  "claude-code",
  "codex",
  "anthropic",
  "openai",
];
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
  "credential.access",
  "privilege.change",
  "external.publish",
];
const STATUSES = [
  "",
  "waiting_approval",
  "approved",
  "running",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
];
const STATUS_STYLE = {
  waiting_approval: "bg-yellow-500/20 text-yellow-300",
  approved: "bg-sky-500/20 text-sky-300",
  running: "bg-indigo-500/20 text-indigo-300",
  succeeded: "bg-green-500/20 text-green-300",
  failed: "bg-red-500/20 text-red-300",
  denied: "bg-red-500/20 text-red-300",
  cancelled: "bg-zinc-500/20 text-zinc-300",
};
const TEXT = {
  intro:
    "Supervised task control plane. Tasks are proposed, reviewed and audited here. Nothing is executed: model, VM and browser execution stay disabled until the owner's execution preconditions are verified.",
  disabled:
    "NyteDesk is disabled. The server owner sets NYTEDESK_ENABLED=true to turn it on.",
  singleUser:
    "NyteDesk needs multi-user mode: a task must be approved by a different, authenticated user.",
  agents:
    "The local LLM coordinates, Claude Code implements, Codex reviews. Agents can recommend work but can never approve it, and none can execute in this phase.",
  propose:
    "Every action needs approval from a different manager or administrator. Protected actions (VM write/execute, browser interaction, git push/merge, credentials, privileges, publication) need an administrator.",
  approvals: "Open a task to review its exact payload before deciding.",
  providers:
    "Hosted model APIs only: endpoints and model names. API keys are never stored by NyteDesk: name an environment variable (NYTEDESK_…) that the server owner sets. Anthropic and OpenAI use their official API origins. Local engines are configured under Local AI Engines; the Claude Code and Codex CLIs are configured inside the VM.",
};
const input =
  "bg-theme-settings-input-bg text-white text-sm rounded-lg p-2 border border-white/10";
const muted = "text-xs text-theme-text-secondary";
const card = "rounded-lg border border-white/10 p-3 text-xs";
const outer =
  "w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex";
const panel =
  "relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-zinc-900 light:bg-white w-full h-full overflow-y-scroll p-4 md:p-0";
const column = "flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16";

const short = (h) => (h ? `${h.slice(0, 12)}…` : "");
const yesNo = (v) => (v ? "yes" : "no");

function Section({ title, description, children }) {
  return (
    <div className="w-full flex flex-col gap-y-2 py-4 border-white/10 border-b">
      <p className="text-base font-semibold text-theme-text-primary">{title}</p>
      {description && <p className={muted}>{description}</p>}
      {children}
    </div>
  );
}

function StatusBadge({ status }) {
  const style = STATUS_STYLE[status] || "bg-zinc-700 text-white";
  const className = `px-2 py-0.5 rounded text-xs font-mono ${style}`;
  return <span className={className}>{status}</span>;
}

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
  const role = user?.role;

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
    if (["admin", "manager"].includes(role)) {
      const pr = await NyteDesk.providers();
      setProviders(pr.ok ? pr.data.providers : null);
    }
    setLoading(false);
  }, [filter, role]);

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

  const ready = status?.enabled && status?.multiUser;
  const height = isMobile ? "100%" : "calc(100% - 32px)";
  return (
    <div className={outer}>
      <Sidebar />
      <div style={{ height }} className={panel}>
        <div className={column}>
          <Header />
          <StatusPanel status={status} loading={loading} />
          {ready && (
            <Dashboard
              agents={agents}
              workspaces={workspaces}
              approvals={approvals}
              tasks={tasks}
              filter={filter}
              setFilter={setFilter}
              selected={selected}
              setSelected={setSelected}
              providers={providers}
              isAdmin={role === "admin"}
              role={role}
              openTask={openTask}
              afterChange={afterChange}
              refresh={refresh}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="w-full flex flex-col gap-y-1 pb-4 border-white/10 border-b-2">
      <p className="text-lg leading-6 font-bold text-theme-text-primary">
        NyteDesk
      </p>
      <p className={muted}>{TEXT.intro}</p>
      <Link
        to="/nytedesk"
        className="self-start text-sm underline text-theme-text-primary"
      >
        Open the NyteDesk dashboard
      </Link>
    </div>
  );
}

function Dashboard(props) {
  const { selected, setSelected, afterChange } = props;
  return (
    <>
      <AgentsPanel agents={props.agents} />
      <LocalAIEngines role={props.role} />
      <CreateTask workspaces={props.workspaces} onCreated={afterChange} />
      <Approvals approvals={props.approvals} onOpen={props.openTask} />
      <History
        tasks={props.tasks}
        filter={props.filter}
        setFilter={props.setFilter}
        onOpen={props.openTask}
      />
      {selected && (
        <TaskDetail
          key={`${selected.task.id}-${selected.task.version}`}
          detail={selected}
          onClose={() => setSelected(null)}
          onChanged={afterChange}
        />
      )}
      {props.providers && (
        <Providers
          providers={props.providers}
          isAdmin={props.isAdmin}
          onSaved={props.refresh}
        />
      )}
    </>
  );
}

function StatusPanel({ status, loading }) {
  if (loading) return <p className="text-sm py-4">Loading…</p>;
  if (!status || status.error) {
    const why = status?.error || "unknown";
    return <p className="text-sm text-red-300 py-4">{`Unavailable: ${why}`}</p>;
  }
  const flags = [
    ["enabled", status.enabled],
    ["multi-user", status.multiUser],
    ["mode", status.mode || "supervised"],
    ["execution", !!status.executionEnabled],
    ["browser automation", !!status.browserAutomation],
    ["VM operations", !!status.vmOperations],
  ];
  const pre = status.executionPreconditions || [];
  const warn = "text-xs text-yellow-300";
  return (
    <Section title="Status">
      <div className="flex flex-wrap gap-3 text-xs font-mono">
        {flags.map(([k, v]) => (
          <span key={k}>{`${k}: ${String(v)}`}</span>
        ))}
      </div>
      {!status.enabled && <p className={warn}>{TEXT.disabled}</p>}
      {status.enabled && !status.multiUser && (
        <p className={warn}>{TEXT.singleUser}</p>
      )}
      {pre.length > 0 && (
        <ul className="text-xs font-mono">
          {pre.map((p) => (
            <li key={p.id}>{`${p.verified ? "✓" : "✗"} ${p.id}`}</li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function AgentsPanel({ agents }) {
  return (
    <Section title="Agents" description={TEXT.agents}>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {agents.map((a) => (
          <div key={a.id} className={card}>
            <p className="font-semibold text-sm">{a.id}</p>
            <p>{`role: ${a.role} · ${a.runtime}`}</p>
            <p>{`configured: ${yesNo(a.configured)}`}</p>
            <p>{`key present: ${yesNo(a.keyPresent)}`}</p>
            <p>{`may approve: ${yesNo(a.mayApprove)}`}</p>
            <p>execution: disabled</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Select({ value, onChange, options, placeholder }) {
  return (
    <select className={input} value={value} onChange={onChange}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

const EMPTY_TASK = {
  slug: "",
  adapter: "ollama",
  action: "model.prompt",
  description: "",
};

export function CreateTask({ workspaces, onCreated }) {
  const [form, setForm] = useState(EMPTY_TASK);
  // One key per intended task: a retry after a network error re-sends the
  // same key, so the server returns the task it already created.
  const [key, setKey] = useState(() => NyteDesk.newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => {
    setForm({ ...form, [k]: e.target.value });
    setKey(NyteDesk.newIdempotencyKey());
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!form.slug || !form.description.trim()) {
      return showToast("Choose a workspace and describe the task", "error");
    }
    setBusy(true);
    const body = {
      description: form.description,
      adapter: form.adapter,
      action: form.action,
    };
    const r = await NyteDesk.createTask(form.slug, body, key);
    setBusy(false);
    if (!r.ok) return showToast(r.error, "error");
    showToast("Task submitted for approval", "success");
    setForm({ ...form, description: "" });
    setKey(NyteDesk.newIdempotencyKey());
    onCreated(r.data.task.id);
  };
  const wsOptions = workspaces.map((w) => [w.slug, w.name || w.slug]);
  return (
    <Section title="Propose a task" description={TEXT.propose}>
      <form onSubmit={submit} className="flex flex-col gap-2 max-w-2xl">
        <div className="flex flex-wrap gap-2">
          <Select
            value={form.slug}
            onChange={set("slug")}
            options={wsOptions}
            placeholder="Workspace…"
          />
          <Select
            value={form.adapter}
            onChange={set("adapter")}
            options={ADAPTERS.map((a) => [a, a])}
          />
          <Select
            value={form.action}
            onChange={set("action")}
            options={ACTIONS.map((a) => [a, a])}
          />
        </div>
        <textarea
          className={`${input} min-h-[80px]`}
          maxLength={4000}
          placeholder="Describe exactly what should be done"
          value={form.description}
          onChange={set("description")}
        />
        <div>
          {/* A real submit button: CTAButton calls onClick() without the
              event, so submit(e) would throw before the implicit submit. */}
          <button
            type="submit"
            disabled={busy}
            className="border-none text-xs px-4 py-1 font-semibold light:text-[#ffffff] rounded-lg bg-primary-button hover:bg-secondary hover:text-white h-[34px] w-fit disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit for approval"}
          </button>
        </div>
      </form>
    </Section>
  );
}

function Approvals({ approvals, onOpen }) {
  const title = `Pending approvals (${approvals.length})`;
  return (
    <Section title={title} description={TEXT.approvals}>
      {approvals.length === 0 && <p className={muted}>Nothing is waiting.</p>}
      {approvals.map((t) => (
        <ApprovalRow key={t.id} task={t} onOpen={onOpen} />
      ))}
    </Section>
  );
}

function ApprovalRow({ task, onOpen }) {
  const summary = `${task.action} · ${task.adapter} · ${task.workspaceSlug}`;
  const note = task.protected ? "protected · admin only" : "";
  return (
    <div className={`${card} flex items-center justify-between gap-2`}>
      <div className="flex flex-col min-w-0">
        <span className="font-mono">{summary}</span>
        <span className="truncate">{task.description}</span>
      </div>
      <div className="flex gap-2 shrink-0">
        {note && <span className="text-yellow-300">{note}</span>}
        <button className="underline" onClick={() => onOpen(task.id)}>
          Review
        </button>
        {!task.canDecide && <span className={muted}>not yours to decide</span>}
      </div>
    </div>
  );
}

function History({ tasks, filter, setFilter, onOpen }) {
  const options = STATUSES.map((s) => [s, s || "all statuses"]);
  return (
    <Section title="Task history">
      <div>
        <Select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          options={options}
        />
      </div>
      <table className="w-full text-xs text-theme-text-primary">
        <thead>
          <tr className="text-left text-theme-text-secondary">
            <th className="py-1">Created</th>
            <th>Workspace</th>
            <th>Action</th>
            <th>Agent</th>
            <th>Status</th>
            <th>Execution</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <HistoryRow key={t.id} task={t} onOpen={onOpen} />
          ))}
        </tbody>
      </table>
      {tasks.length === 0 && <p className={muted}>No tasks.</p>}
    </Section>
  );
}

function HistoryRow({ task, onOpen }) {
  return (
    <tr className="border-t border-white/5">
      <td className="py-1 font-mono">{task.createdAt}</td>
      <td>{task.workspaceSlug}</td>
      <td className="font-mono">{task.action}</td>
      <td>{task.adapter}</td>
      <td>
        <StatusBadge status={task.status} />
      </td>
      <td>{task.executionEnabled ? "enabled" : "disabled"}</td>
      <td>
        <button className="underline" onClick={() => onOpen(task.id)}>
          Details
        </button>
      </td>
    </tr>
  );
}

function confirmApproval(task) {
  const lines = [
    `Approve "${task.action}" via ${task.adapter} in ${task.workspaceSlug}?`,
    `Payload hash ${task.payloadHash}`,
    task.description,
  ];
  return window.confirm(lines.join("\n\n"));
}

function TaskDetail({ detail, onClose, onChanged }) {
  const { task, audit, auditVerified, auditProblems } = detail;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per (task version, operation): double clicks and retries replay
  // the stored result instead of repeating the operation.
  const [keys] = useState(() => ({
    approve: NyteDesk.newIdempotencyKey(),
    deny: NyteDesk.newIdempotencyKey(),
    cancel: NyteDesk.newIdempotencyKey(),
  }));
  const act = async (op) => {
    if (op === "approve" && !confirmApproval(task)) return;
    setBusy(true);
    const r =
      op === "cancel"
        ? await NyteDesk.cancel(task, reason, keys.cancel)
        : await NyteDesk.decide(task, op, reason, keys[op]);
    setBusy(false);
    if (!r.ok) return showToast(r.error, "error");
    showToast(`Task ${r.data.task.status}`, "success");
    onChanged(task.id);
  };
  const execution = task.executionEnabled ? "enabled" : "disabled";
  const protectedNote = detail.protected ? " (protected)" : "";
  const facts = [
    `version ${task.version} · execution ${execution}`,
    `workspace ${task.workspaceSlug} · requested by user ${task.requesterId}`,
    `${task.action} via ${task.adapter}${protectedNote}`,
    `payload hash ${task.payloadHash}`,
  ];
  const chain = auditVerified
    ? "Audit chain verified"
    : `Audit chain FAILED: ${auditProblems.join("; ")}`;
  const chainStyle = auditVerified ? "text-green-300" : "text-red-300";
  return (
    <Section title="Task detail">
      <div className={`${card} flex flex-col gap-1`}>
        <div className="flex justify-between">
          <span className="font-mono">{task.id}</span>
          <button className="underline" onClick={onClose}>
            Close
          </button>
        </div>
        <StatusBadge status={task.status} />
        {facts.map((f) => (
          <p key={f} className="break-all">
            {f}
          </p>
        ))}
        <p className="whitespace-pre-wrap border border-white/5 rounded p-2">
          {task.description}
        </p>
        {task.approval && <ApprovalLine approval={task.approval} />}
        <p className={chainStyle}>{chain}</p>
        <AuditList audit={audit} />
        <Actions
          detail={detail}
          busy={busy}
          reason={reason}
          setReason={setReason}
          act={act}
        />
      </div>
    </Section>
  );
}

function ApprovalLine({ approval: a }) {
  const expires = a.expiresAt ? ` · expires ${a.expiresAt}` : "";
  const who = `${a.decision} by user ${a.by} (${a.role}) at ${a.at}`;
  return <p>{`${who}${expires} · decision ${short(a.decisionId)}`}</p>;
}

function auditLine(e) {
  const who = `by user ${e.actorId} (${e.actorRole})`;
  return `${e.sequence}. ${e.at} ${e.event} ${who} · ${short(e.hash)}`;
}

function AuditList({ audit }) {
  return (
    <ol className="font-mono">
      {audit.map((e) => (
        <li key={e.sequence}>{auditLine(e)}</li>
      ))}
    </ol>
  );
}

function Actions({ detail, busy, reason, setReason, act }) {
  if (!detail.canDecide && !detail.canCancel) return null;
  return (
    <div className="flex flex-wrap gap-2 items-center pt-2">
      <input
        className={input}
        placeholder="Reason (optional)"
        maxLength={1000}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {detail.canDecide && (
        <CTAButton disabled={busy} onClick={() => act("approve")}>
          Approve
        </CTAButton>
      )}
      {detail.canDecide && (
        <CTAButton disabled={busy} onClick={() => act("deny")}>
          Deny
        </CTAButton>
      )}
      {detail.canCancel && (
        <CTAButton disabled={busy} onClick={() => act("cancel")}>
          Cancel task
        </CTAButton>
      )}
    </div>
  );
}

function Providers({ providers, isAdmin, onSaved }) {
  return (
    <Section title="Provider configuration" description={TEXT.providers}>
      {providers.map((p) => (
        <ProviderRow
          key={`${p.id}-${p.version}`}
          provider={p}
          isAdmin={isAdmin}
          onSaved={onSaved}
        />
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
  const field = (name) => (e) => setForm({ ...form, [name]: e.target.value });
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
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="w-20 font-semibold">{provider.id}</span>
      <input
        className={input}
        disabled={!isAdmin}
        placeholder="Base URL"
        value={form.baseUrl}
        onChange={field("baseUrl")}
      />
      <input
        className={input}
        disabled={!isAdmin}
        placeholder="Model"
        value={form.model}
        onChange={field("model")}
      />
      <input
        className={input}
        disabled={!isAdmin}
        placeholder="NYTEDESK_… key variable"
        value={form.keyEnv}
        onChange={field("keyEnv")}
      />
      <span>{`key present: ${yesNo(provider.keyPresent)}`}</span>
      {isAdmin && <CTAButton onClick={save}>Save</CTAButton>}
    </div>
  );
}
