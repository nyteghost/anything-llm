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
const STATUS_STYLE = {
  external: "bg-green-500/20 text-green-300",
  stopped: "bg-zinc-500/20 text-zinc-300",
  failed: "bg-red-500/20 text-red-300",
  unknown: "bg-zinc-700 text-white",
};
const input =
  "bg-theme-settings-input-bg text-white text-xs rounded-lg p-2 border border-white/10";
const card =
  "rounded-lg border border-white/10 p-3 text-xs flex flex-col gap-1";
const muted = "text-xs text-theme-text-secondary";

const toInt = (value) => (value === "" ? null : Number(value));

function StatusBadge({ check }) {
  const status = check?.status || "unknown";
  const style = STATUS_STYLE[status] || STATUS_STYLE.unknown;
  const label = status === "external" ? "available (external)" : status;
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
      {error && <p className="text-xs text-red-300">{error}</p>}
      {data && <Selection selection={data.selection} />}
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

function Selection({ selection }) {
  if (!selection) {
    return <p className={muted}>No engine is selected for the coordinator.</p>;
  }
  const model = selection.model ? ` · ${selection.model}` : "";
  const where = `${selection.engineId} at ${selection.endpoint}${model}`;
  const text = `Coordinator engine: ${where}`;
  return <p className="text-xs text-theme-text-primary">{text}</p>;
}

function EngineCard({ engine, selection, canCheck, isAdmin, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selectKey] = useState(() => NyteDesk.newIdempotencyKey());
  const check = engine.lastCheck;
  const selected = selection?.engineId === engine.id;

  const runCheck = async () => {
    setBusy(true);
    const r = await NyteDesk.checkEngine(engine.id);
    setBusy(false);
    if (!r.ok) return showToast(r.error, "error");
    showToast(`${engine.name}: ${r.data.check.status}`, "info");
    onChanged();
  };

  const select = async () => {
    const expected = selection?.selectionId ?? null;
    const r = await NyteDesk.selectEngine(engine.id, expected, selectKey);
    if (!r.ok) return showToast(r.error, "error");
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
        <StatusBadge check={check} />
      </div>
      <p className="font-mono break-all">{`${endpoint}${defaultNote}`}</p>
      <p>{apiLine}</p>
      {sizing.length > 0 && <p>{sizing.join(" · ")}</p>}
      <p className={muted}>externally owned · start/stop disabled</p>
      {hint && <p className={muted}>{hint}</p>}
      {selected && (
        <p className="text-green-300">selected for the coordinator</p>
      )}
      {check && <CheckResult check={check} />}
      <div className="flex flex-wrap gap-2 pt-1">
        {canCheck && (
          <CTAButton disabled={busy} onClick={runCheck}>
            {busy ? "Checking…" : "Check"}
          </CTAButton>
        )}
        {isAdmin && check?.status === "external" && !selected && (
          <CTAButton onClick={select}>Select</CTAButton>
        )}
        {isAdmin && (
          <CTAButton onClick={() => setEditing(!editing)}>
            {editing ? "Close" : "Configure"}
          </CTAButton>
        )}
      </div>
      {editing && <EngineForm engine={engine} onSaved={onChanged} />}
    </div>
  );
}

function CheckResult({ check }) {
  const models = check.models.slice(0, 8).join(", ");
  const more = check.models.length > 8 ? ` +${check.models.length - 8}` : "";
  const when = `checked ${check.checkedAt}`;
  const latency = check.latencyMs !== null ? ` · ${check.latencyMs} ms` : "";
  return (
    <div className="flex flex-col gap-0.5 border-t border-white/5 pt-1">
      <p className={muted}>{`${when}${latency}`}</p>
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
  const [key] = useState(() => NyteDesk.newIdempotencyKey());
  const field = (name) => (e) => setForm({ ...form, [name]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    const body = {
      endpoint: form.endpoint || null,
      model: form.model || null,
      contextWindow: toInt(form.contextWindow),
      vramReserveMiB: toInt(form.vramReserveMiB),
      expectedVersion: engine.version,
    };
    if (engine.id === "strata") body.api = form.api || null;
    const r = await NyteDesk.saveEngine(engine.id, body, key);
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
        <select className={input} value={form.api} onChange={field("api")}>
          <option value="">API style…</option>
          <option value="openai">OpenAI-compatible</option>
          <option value="ollama">Ollama</option>
        </select>
      )}
      <input
        className={input}
        placeholder="Model"
        value={form.model}
        onChange={field("model")}
      />
      <div className="flex gap-1">
        <input
          className={input}
          type="number"
          placeholder="Context window"
          value={form.contextWindow}
          onChange={field("contextWindow")}
        />
        <input
          className={input}
          type="number"
          placeholder="VRAM reserve MiB"
          value={form.vramReserveMiB}
          onChange={field("vramReserveMiB")}
        />
      </div>
      <div>
        <CTAButton onClick={save}>Save</CTAButton>
      </div>
    </form>
  );
}
