import { useCallback, useEffect, useState } from "react";
import CTAButton from "@/components/lib/CTAButton";
import NyteDesk from "@/models/nytedesk";
import showToast from "@/utils/toast";

const TEXT = {
  description:
    "Local inference engines NyteDesk can see. NyteDesk only reads each engine's model list over loopback HTTP. It never starts, stops, restarts, unloads or kills an engine: running engines are externally owned.",
  polystrata:
    "PolyStrata's port can change between sessions; update the endpoint when it does.",
  strata: "Strata has no default endpoint; set its endpoint and API style.",
};
// A probe can only tell whether the engine answered. "stopped" from the probe
// means "did not answer": NyteDesk cannot know whether the process is running.
const STATUS_VIEW = {
  external: ["reachable", "bg-green-500/20 text-green-300"],
  stopped: ["unreachable", "bg-red-500/20 text-red-300"],
  failed: ["check failed", "bg-red-500/20 text-red-300"],
  unknown: ["not checked", "bg-zinc-700 text-white"],
};
const ROLE_NOTE = {
  admin: "You can check, configure and select engines.",
  manager:
    "You can run availability checks. Configuring or selecting an engine requires an administrator.",
  default:
    "Read-only view. Checks require a manager or administrator; configuring or selecting an engine requires an administrator.",
};
const input =
  "bg-theme-settings-input-bg text-white text-xs rounded-lg p-2 border border-white/10";
const card =
  "rounded-lg border border-white/10 p-3 text-xs flex flex-col gap-1";
const muted = "text-xs text-theme-text-secondary";

const toInt = (value) => (value === "" ? null : Number(value));

function StatusBadge({ engine }) {
  const check = engine.lastCheck;
  const status = engine.endpoint ? check?.status || "unknown" : "unconfigured";
  const [label, style] =
    status === "unconfigured"
      ? ["not configured", "bg-zinc-700 text-white"]
      : STATUS_VIEW[status] || STATUS_VIEW.unknown;
  return (
    <span className={`px-2 py-0.5 rounded font-mono w-fit ${style}`}>
      {label}
    </span>
  );
}

export default function LocalAIEngines({ role }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const canCheck = ["admin", "manager"].includes(role);
  const isAdmin = role === "admin";

  const load = useCallback(async () => {
    const r = await NyteDesk.engines();
    if (!r.ok) return setError(r.error);
    setError(null);
    setData(r.data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="w-full flex flex-col gap-y-2 py-4 border-white/10 border-b">
      <p className="text-base font-semibold text-theme-text-primary">
        Local AI Engines
      </p>
      <p className={muted}>{TEXT.description}</p>
      <p className={muted}>{ROLE_NOTE[role] || ROLE_NOTE.default}</p>
      {error && <p className="text-xs text-red-300">{error}</p>}
      {data && <Selection selection={data.selection} engines={data.engines} />}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {(data?.engines || []).map((engine) => (
          <EngineCard
            key={`${engine.id}-${engine.version}`}
            engine={engine}
            selection={data.selection}
            canCheck={canCheck}
            isAdmin={isAdmin}
            onChanged={load}
          />
        ))}
      </div>
    </div>
  );
}

function Selection({ selection, engines }) {
  if (!selection) {
    return <p className={muted}>No engine is selected for the coordinator.</p>;
  }
  const model = selection.model ? ` · ${selection.model}` : "";
  const where = `${selection.engineId} at ${selection.endpoint}${model}`;
  const text = `Coordinator engine: ${where}`;
  const engine = engines.find((e) => e.id === selection.engineId);
  const status = engine?.lastCheck?.status;
  const changed =
    engine &&
    (engine.endpoint !== selection.endpoint ||
      (engine.model ?? null) !== (selection.model ?? null));
  let warning = null;
  if (changed) {
    warning =
      "Its configuration changed after it was selected; check and select it again.";
  } else if (status && status !== "external") {
    warning = "The last check could not reach it.";
  }
  return (
    <div className="text-xs flex flex-col gap-0.5">
      <p className="text-theme-text-primary">{text}</p>
      {warning && <p className="text-amber-300">{warning}</p>}
    </div>
  );
}

function EngineCard({ engine, selection, canCheck, isAdmin, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // One key per attempt: reused only to retry a request that never got an
  // answer, replaced once the server has answered.
  const [selectKey, setSelectKey] = useState(() =>
    NyteDesk.newIdempotencyKey()
  );
  const check = engine.lastCheck;
  const selected = selection?.engineId === engine.id;

  const runCheck = async () => {
    setBusy(true);
    const r = await NyteDesk.checkEngine(engine.id);
    setBusy(false);
    if (!r.ok) return showToast(r.error, "error");
    const view = STATUS_VIEW[r.data.check.status] || STATUS_VIEW.unknown;
    showToast(`${engine.name}: ${view[0]}`, "info");
    onChanged();
  };

  const select = async () => {
    const expected = selection?.selectionId ?? null;
    setBusy(true);
    const r = await NyteDesk.selectEngine(engine.id, expected, selectKey);
    setBusy(false);
    if (r.status !== 0) setSelectKey(NyteDesk.newIdempotencyKey());
    if (!r.ok) {
      showToast(r.error, "error");
      return onChanged();
    }
    showToast(`${engine.name} selected`, "success");
    onChanged();
  };

  const endpoint = engine.endpoint || "not configured";
  const defaultNote = engine.endpointIsDefault ? " (default)" : "";
  const sizing = [
    engine.contextWindow ? `context ${engine.contextWindow}` : null,
    engine.vramReserveMiB !== null
      ? `VRAM reserve ${engine.vramReserveMiB} MiB`
      : null,
  ].filter(Boolean);
  const hint = TEXT[engine.id];
  const api = engine.api || "not set";
  const apiLine = `API: ${api} · model: ${engine.model || "none"}`;
  return (
    <div className={card}>
      <div className="flex justify-between items-center">
        <p className="font-semibold text-sm">{engine.name}</p>
        <StatusBadge engine={engine} />
      </div>
      <p className="font-mono break-all">{`${endpoint}${defaultNote}`}</p>
      <p>{apiLine}</p>
      {sizing.length > 0 && <p>{sizing.join(" · ")}</p>}
      <p className={muted}>externally owned · start/stop disabled</p>
      {hint && <p className={muted}>{hint}</p>}
      {selected && (
        <p className="text-green-300">selected for the coordinator</p>
      )}
      {check && <CheckResult check={check} endpoint={engine.endpoint} />}
      {isAdmin && !selected && engine.selectionBlockedReason && (
        <p className="text-amber-300">{`Select: ${engine.selectionBlockedReason}`}</p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {canCheck && (
          <CTAButton className="!mr-0" disabled={busy} onClick={runCheck}>
            {busy ? "Checking…" : "Check"}
          </CTAButton>
        )}
        {isAdmin && engine.selectable && !selected && (
          <CTAButton className="!mr-0" disabled={busy} onClick={select}>
            Select
          </CTAButton>
        )}
        {isAdmin && (
          <CTAButton className="!mr-0" onClick={() => setEditing(!editing)}>
            {editing ? "Close" : "Configure"}
          </CTAButton>
        )}
      </div>
      {editing && <EngineForm engine={engine} onSaved={onChanged} />}
    </div>
  );
}

function CheckResult({ check, endpoint }) {
  const models = check.models.slice(0, 8).join(", ");
  const more = check.models.length > 8 ? ` +${check.models.length - 8}` : "";
  const when = `checked ${new Date(check.checkedAt).toLocaleString()}`;
  const latency = check.latencyMs !== null ? ` · ${check.latencyMs} ms` : "";
  const http = check.httpStatus ? ` · HTTP ${check.httpStatus}` : "";
  return (
    <div className="flex flex-col gap-0.5 border-t border-white/5 pt-1">
      <p className={muted}>{`${when}${latency}${http}`}</p>
      {check.endpoint && check.endpoint !== endpoint && (
        <p className="text-amber-300">{`This check was for ${check.endpoint}, not the current endpoint.`}</p>
      )}
      {check.model && (
        <p>{`model ${check.model}: ${check.modelListed ? "listed" : "not listed"}`}</p>
      )}
      {models && <p className="break-all">{`models: ${models}${more}`}</p>}
      <ul>
        {check.diagnostics.map((d) => (
          <li key={d.code} className="text-theme-text-secondary">
            {`${d.code}: ${d.message}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EngineForm({ engine, onSaved }) {
  const [form, setForm] = useState({
    endpoint: engine.endpointIsDefault ? "" : engine.endpoint || "",
    api: engine.api || "",
    model: engine.model || "",
    contextWindow: engine.contextWindow ?? "",
    vramReserveMiB: engine.vramReserveMiB ?? "",
  });
  const [key, setKey] = useState(() => NyteDesk.newIdempotencyKey());
  const [saving, setSaving] = useState(false);
  const field = (name) => (e) => setForm({ ...form, [name]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    if (saving) return;
    const body = {
      endpoint: form.endpoint || null,
      model: form.model || null,
      contextWindow: toInt(form.contextWindow),
      vramReserveMiB: toInt(form.vramReserveMiB),
      expectedVersion: engine.version,
    };
    if (engine.id === "strata") body.api = form.api || null;
    setSaving(true);
    const r = await NyteDesk.saveEngine(engine.id, body, key);
    setSaving(false);
    if (r.status !== 0) setKey(NyteDesk.newIdempotencyKey());
    if (!r.ok) return showToast(r.error, "error");
    showToast(`${engine.name} saved`, "success");
    onSaved();
  };
  const placeholder =
    engine.id === "ollama"
      ? "http://127.0.0.1:11434"
      : "http://127.0.0.1:PORT/v1";
  return (
    <form onSubmit={save} className="flex flex-col gap-1 pt-1">
      <label className={muted} htmlFor={`${engine.id}-endpoint`}>
        Endpoint (loopback only)
      </label>
      <input
        id={`${engine.id}-endpoint`}
        className={input}
        placeholder={placeholder}
        value={form.endpoint}
        onChange={field("endpoint")}
      />
      {engine.id === "strata" && (
        <select
          className={input}
          aria-label="API style"
          value={form.api}
          onChange={field("api")}
        >
          <option value="">API style…</option>
          <option value="openai">OpenAI-compatible</option>
          <option value="ollama">Ollama</option>
        </select>
      )}
      <input
        className={input}
        placeholder="Model"
        aria-label="Model"
        value={form.model}
        onChange={field("model")}
      />
      <div className="flex gap-1">
        <input
          className={input}
          type="number"
          placeholder="Context window"
          aria-label="Context window (tokens)"
          min={512}
          value={form.contextWindow}
          onChange={field("contextWindow")}
        />
        <input
          className={input}
          type="number"
          placeholder="VRAM reserve MiB"
          aria-label="VRAM reserve (MiB)"
          min={0}
          value={form.vramReserveMiB}
          onChange={field("vramReserveMiB")}
        />
      </div>
      <div>
        <button
          type="submit"
          disabled={saving}
          className="border-none text-xs px-4 py-1 font-semibold light:text-[#ffffff] rounded-lg bg-primary-button hover:bg-secondary hover:text-white h-[34px] w-fit disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
