import { Link } from "react-router-dom";
import { ArrowRight, Info, WarningCircle } from "@phosphor-icons/react";
import { freshness } from "@/utils/nytedesk/layout";
import {
  OPEN_BACKEND_STATES,
  describeAdapter,
  ACTION_INFO,
} from "@/utils/nytedesk/taskState";
import {
  Badge,
  Card,
  ENGINE_NAMES,
  EngineStatus,
  Meter,
  StateBadge,
  Unavailable,
  formatBytes,
  muted,
  surface,
  timeAgo,
} from "./ui";

function Kpi({ label, value, detail, to, children }) {
  const body = (
    <>
      <span className={`text-xs ${muted} flex items-center justify-between`}>
        {label}
        {to && <ArrowRight size={14} aria-hidden="true" />}
      </span>
      <span className="text-lg font-semibold truncate">{value}</span>
      {detail && (
        <span className="flex flex-wrap gap-1 items-center text-xs">
          {detail}
        </span>
      )}
      {children}
    </>
  );
  const cls = `${surface} p-3 flex flex-col gap-1 min-w-0`;
  return to ? (
    <Link to={to} className={`${cls} hover:border-indigo-400/50`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function KpiCards({
  engines,
  tasks,
  approvals,
  components,
  telemetry,
  now,
}) {
  const selection = engines?.selection;
  const selected = engines?.engines?.find((e) => e.id === selection?.engineId);
  const open = tasks.filter((t) => OPEN_BACKEND_STATES.includes(t.status));
  const executing = tasks.filter((t) => t.status === "running");
  const agents = components.filter((c) => c.kind === "agent");
  const fresh = telemetry ? freshness(telemetry.sampledAt, now) : null;
  const ctx = selected?.contextWindow;
  return (
    <section
      aria-label="Overview"
      className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3"
    >
      <Kpi
        label="Active engine"
        value={
          selection
            ? ENGINE_NAMES[selection.engineId] || selection.engineId
            : "None selected"
        }
        to="/nytedesk/engines"
        detail={
          selection ? (
            <>
              <Badge>Local · externally owned</Badge>
              <EngineStatus engine={selected} />
            </>
          ) : (
            <span className={muted}>Select one in Local AI Manager</span>
          )
        }
      />
      <Kpi
        label="Model"
        value={selection?.model || "—"}
        detail={
          ctx ? (
            <Badge tone="info">{`${Math.round(ctx / 1024)}k context`}</Badge>
          ) : null
        }
      />
      <Kpi
        label="Open tasks"
        value={String(open.length)}
        to="/nytedesk/tasks"
        detail={
          <span className={muted}>{`${executing.length} executing`}</span>
        }
      />
      <Kpi
        label="Pending approvals"
        value={String(approvals.length)}
        to="/nytedesk/approvals"
        detail={
          approvals.length ? (
            <Badge tone="warning">Needs review</Badge>
          ) : (
            <span className={muted}>Nothing waiting</span>
          )
        }
      />
      <Kpi
        label="Agents"
        value={`${agents.length} registered`}
        to="/nytedesk/agentbridge"
        detail={<span className={muted}>0 active · execution disabled</span>}
      />
      <Kpi
        label="System health"
        value={
          telemetry?.host?.cpuPercent != null
            ? `CPU ${telemetry.host.cpuPercent}%`
            : "Measuring…"
        }
        to="/nytedesk/logs"
        detail={
          <span className={fresh?.stale ? "text-amber-300" : muted}>
            {telemetry ? `GPU unavailable · ${fresh.label}` : "No sample yet"}
          </span>
        }
      />
    </section>
  );
}

const GROUPS = [
  { kind: "agent", title: "Agents" },
  { kind: "engine", title: "Inference engines (not agents)" },
  { kind: "orchestrator", title: "Orchestration and policy" },
];

export function AgentsPanel({ components, engines }) {
  const engineById = Object.fromEntries(
    (engines?.engines || []).map((e) => [e.id, e])
  );
  const selection = engines?.selection;
  return (
    <Card title="Agents and roles" labelledBy="nd-agents">
      {GROUPS.map((g) => {
        const items = components.filter((c) => c.kind === g.kind);
        if (!items.length) return null;
        return (
          <div key={g.kind} className="flex flex-col gap-2">
            <h3 className={`text-[11px] uppercase tracking-wide ${muted}`}>
              {g.title}
            </h3>
            <ul className="flex flex-col gap-2">
              {items.map((c) => (
                <li key={c.id} className="flex flex-col gap-0.5">
                  <span className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-medium">{c.name}</span>
                    {c.kind === "engine" ? (
                      <EngineStatus engine={engineById[c.id]} />
                    ) : c.kind === "agent" ? (
                      <Badge>Execution disabled</Badge>
                    ) : (
                      <Badge tone="info">Enforcing</Badge>
                    )}
                  </span>
                  <span className={`text-xs ${muted}`}>
                    {c.role === "coordinator" && selection
                      ? `Coordinator · runs on ${ENGINE_NAMES[selection.engineId]}${selection.model ? ` (${selection.model})` : ""}`
                      : `${c.role} · ${c.runsOn}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p className={`text-xs ${muted} flex gap-1`}>
        <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
        No agent can approve. Approvals come from people, and AgentBridge
        enforces them.
      </p>
    </Card>
  );
}

function Metric({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className={muted}>{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

export function MetricsPanel({ telemetry, telemetryError, now }) {
  const fresh = telemetry ? freshness(telemetry.sampledAt, now) : null;
  const h = telemetry?.host;
  const memPct = h ? (100 * h.memoryUsedBytes) / h.memoryTotalBytes : null;
  return (
    <Card
      title="System metrics"
      labelledBy="nd-metrics"
      action={
        fresh && (
          <span
            className={`text-[11px] ${fresh.stale ? "text-amber-300" : muted}`}
          >
            {fresh.stale ? `Stale · ${fresh.label}` : `Updated ${fresh.label}`}
          </span>
        )
      }
    >
      {telemetryError && (
        <p className="text-xs text-red-300">{telemetryError}</p>
      )}
      {!telemetry && !telemetryError && (
        <p className={`text-xs ${muted}`}>Waiting for the first sample…</p>
      )}
      {telemetry && (
        <>
          <p className={`text-[11px] ${muted}`}>
            Measured on the NyteDesk server host.
          </p>
          <Metric label="CPU">
            {h.cpuPercent != null ? (
              `${h.cpuPercent}% of ${h.cpuCount} cores`
            ) : (
              <Unavailable reason={h.cpuReason} />
            )}
          </Metric>
          <Meter percent={h.cpuPercent} label="CPU utilization" />
          <Metric label="RAM">{`${formatBytes(h.memoryUsedBytes)} / ${formatBytes(h.memoryTotalBytes)}`}</Metric>
          <Meter percent={memPct} label="Memory used" />
          <Metric label="GPU utilization">
            <Unavailable reason={telemetry.gpu.reason} />
          </Metric>
          <Metric label="VRAM">
            <Unavailable reason={telemetry.gpu.reason} />
          </Metric>
          <Metric label="GPU temperature">
            <Unavailable reason={telemetry.gpu.reason} />
          </Metric>
          <Metric label="Tokens / second">
            <Unavailable reason={telemetry.inference.reason} />
          </Metric>
          <Metric label="Context usage">
            {telemetry.inference.contextWindow ? (
              <span
                title={telemetry.inference.reason}
              >{`Unavailable of ${telemetry.inference.contextWindow.toLocaleString()}`}</span>
            ) : (
              <Unavailable reason={telemetry.inference.reason} />
            )}
          </Metric>
          <p className={`text-[11px] ${muted}`}>{telemetry.gpu.reason}</p>
        </>
      )}
    </Card>
  );
}

export function ActivityPanel({ tasks, now }) {
  const recent = [...tasks]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 6);
  return (
    <Card
      title="Recent activity"
      labelledBy="nd-activity"
      action={
        <Link
          className="text-xs text-indigo-300 light:text-indigo-700 hover:underline"
          to="/nytedesk/tasks"
        >
          All tasks
        </Link>
      }
    >
      {recent.length === 0 ? (
        <p className={`text-xs ${muted}`}>No tasks yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {recent.map((t) => (
            <li key={t.id} className="flex flex-col gap-0.5 text-xs">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {ACTION_INFO[t.action]?.label || t.action}
                </span>
                <span className={`${muted} shrink-0`}>
                  {timeAgo(t.updatedAt, now)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <StateBadge status={t.status} />
                <span className={`${muted} truncate`}>
                  {describeAdapter(t.adapter).name}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function DecisionsPanel({ approvals }) {
  return (
    <Card title="Pending decisions" labelledBy="nd-decisions">
      {approvals.length === 0 ? (
        <p className={`text-xs ${muted}`}>Nothing is waiting for approval.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {approvals.slice(0, 5).map((t) => (
            <li
              key={t.id}
              className="rounded-lg border border-amber-400/30 bg-amber-500/5 p-3 flex flex-col gap-1.5 text-xs"
            >
              <span className="flex items-center gap-1.5 font-medium">
                <WarningCircle
                  size={14}
                  className="text-amber-300"
                  aria-hidden="true"
                />
                {t.protected
                  ? "Administrator approval required"
                  : "Approval required"}
              </span>
              <span className="truncate" title={t.description}>
                {`${describeAdapter(t.adapter).name}: ${ACTION_INFO[t.action]?.label || t.action}`}
              </span>
              <span className={`${muted} line-clamp-2`}>{t.description}</span>
              <Link
                to={`/nytedesk/approvals/${encodeURIComponent(t.id)}`}
                className="self-start rounded-md bg-indigo-500 hover:bg-indigo-400 text-white px-2.5 py-1 font-medium"
              >
                Inspect and decide
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
