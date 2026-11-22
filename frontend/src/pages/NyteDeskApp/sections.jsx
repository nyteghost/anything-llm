import { useState } from "react";
import { Link } from "react-router-dom";
import LocalAIEngines from "@/pages/NyteDesk/LocalAIEngines";
import { CreateTask } from "@/pages/NyteDesk";
import {
  ACTION_INFO,
  DISPLAY_STATES,
  describeAdapter,
  displayState,
  MODEL_CONTROL_ACTIONS,
} from "@/utils/nytedesk/taskState";
import ChatPanel from "./ChatPanel";
import { ResizableSplit } from "./Shell";
import {
  ActivityPanel,
  AgentsPanel,
  DecisionsPanel,
  KpiCards,
  MetricsPanel,
} from "./widgets";
import {
  Badge,
  Card,
  ENGINE_NAMES,
  EngineStatus,
  StateBadge,
  muted,
  timeAgo,
} from "./ui";

export function DashboardSection({ data, layout, updateLayout }) {
  return (
    <div className="flex flex-col gap-4 pt-4 lg:h-full lg:min-h-0">
      <KpiCards
        engines={data.engines}
        tasks={data.tasks}
        approvals={data.approvals}
        components={data.components}
        telemetry={data.telemetry}
        telemetryAllowed={data.telemetryAllowed}
        now={data.now}
      />
      <div className="lg:flex-1 lg:min-h-[600px]">
        <ResizableSplit
          sideLabel="Activity sidebar"
          width={layout.rightWidth}
          onWidth={(w) => updateLayout({ rightWidth: w })}
          main={
            <ChatPanel
              workspaces={data.workspaces}
              engines={data.engines}
              title="AI chat workspace and agent playground"
            />
          }
          side={
            <>
              <AgentsPanel
                components={data.components}
                engines={data.engines}
              />
              <MetricsPanel
                telemetry={data.telemetry}
                telemetryError={data.telemetryError}
                telemetryAllowed={data.telemetryAllowed}
                now={data.now}
              />
              <ActivityPanel tasks={data.tasks} now={data.now} />
              <DecisionsPanel approvals={data.approvals} />
            </>
          }
        />
      </div>
    </div>
  );
}

export function WorkspaceSection({ data, layout, updateLayout }) {
  return (
    <div className="pt-4 lg:h-full lg:min-h-0">
      <ResizableSplit
        sideLabel="Agents sidebar"
        width={layout.rightWidth}
        onWidth={(w) => updateLayout({ rightWidth: w })}
        main={<ChatPanel workspaces={data.workspaces} engines={data.engines} />}
        side={
          <>
            <AgentsPanel components={data.components} engines={data.engines} />
            <DecisionsPanel approvals={data.approvals} />
          </>
        }
      />
    </div>
  );
}

export function EnginesSection({ role }) {
  return (
    <div className="pt-4 max-w-5xl flex flex-col gap-4">
      <LocalAIEngines role={role} />
    </div>
  );
}

const KIND_LABEL = {
  agent: "Agent",
  engine: "Inference engine",
  orchestrator: "Orchestrator",
};

export function AgentBridgeSection({ data }) {
  const engineById = Object.fromEntries(
    (data.engines?.engines || []).map((e) => [e.id, e])
  );
  const preconditions = data.status?.executionPreconditions || [];
  return (
    <div className="pt-4 flex flex-col gap-4 max-w-5xl">
      <Card title="Who does what" labelledBy="nd-roles">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              NyteDesk components and responsibilities
            </caption>
            <thead>
              <tr className={`text-left text-xs ${muted}`}>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Component
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Kind
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Responsibility
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Runs on
                </th>
                <th scope="col" className="py-1 font-medium">
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {data.components.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-white/5 light:border-slate-100 align-top"
                >
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    {c.name}
                  </th>
                  <td className="py-2 pr-3">{KIND_LABEL[c.kind] || c.kind}</td>
                  <td className="py-2 pr-3">{c.responsibility}</td>
                  <td className="py-2 pr-3">{c.runsOn}</td>
                  <td className="py-2">
                    {c.kind === "engine" ? (
                      <EngineStatus engine={engineById[c.id]} />
                    ) : c.kind === "agent" ? (
                      <Badge>Execution disabled</Badge>
                    ) : (
                      <Badge tone="info">Enforcing</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={`text-xs ${muted}`}>
          Task targets named after an engine (ollama, strata, polystrata) mean
          the coordinator model running on that engine. No component may approve
          its own or any other work.
        </p>
      </Card>
      <Card title="Execution preconditions" labelledBy="nd-pre">
        <p className="text-sm">
          Execution is <strong>disabled</strong>. It stays disabled until every
          precondition is verified.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {preconditions.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <Badge tone={p.verified ? "success" : "neutral"}>
                {p.verified ? "Verified" : "Not verified"}
              </Badge>
              <span className="font-mono text-xs">{p.id}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function TaskTable({ tasks, now, linkToInspector }) {
  if (!tasks.length) return <p className={`text-sm ${muted}`}>No tasks.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={`text-left text-xs ${muted}`}>
            <th scope="col" className="py-1 pr-3 font-medium">
              State
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Operation
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Addressed to
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Provenance
            </th>
            <th scope="col" className="py-1 font-medium">
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr
              key={t.id}
              className="border-t border-white/5 light:border-slate-100 align-top"
            >
              <td className="py-2 pr-3">
                <StateBadge status={t.status} action={t.action} />
              </td>
              <td className="py-2 pr-3 max-w-[28rem]">
                <Link
                  to={
                    linkToInspector
                      ? `/nytedesk/approvals/${encodeURIComponent(t.id)}`
                      : `/nytedesk/tasks/${encodeURIComponent(t.id)}`
                  }
                  className="font-medium hover:underline"
                >
                  {ACTION_INFO[t.action]?.label || t.action}
                </Link>
                <p className={`text-xs ${muted} line-clamp-2`}>
                  {t.description}
                </p>
              </td>
              <td className="py-2 pr-3 text-xs">
                {describeAdapter(t.adapter).name}
              </td>
              <td className="py-2 pr-3 text-xs">
                {`Requested by user #${t.requesterId}`}
                {t.approval && (
                  <span className={`block ${muted}`}>
                    {`${t.approval.decision === "approve" ? "Approved" : "Rejected"} by user #${t.approval.by}`}
                  </span>
                )}
                {t.status === "succeeded" &&
                  (MODEL_CONTROL_ACTIONS.includes(t.action) ? (
                    <span className="block text-emerald-300 light:text-emerald-700">
                      Confirmed against the engine&apos;s loaded models
                    </span>
                  ) : (
                    <span className="block text-amber-300">
                      Not independently verified
                    </span>
                  ))}
              </td>
              <td className={`py-2 text-xs ${muted}`}>
                {timeAgo(t.updatedAt, now)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TasksSection({ data }) {
  const [filter, setFilter] = useState("all");
  const tasks =
    filter === "all"
      ? data.tasks
      : data.tasks.filter(
          (t) => displayState(t.status, t.action).id === filter
        );
  return (
    <div className="pt-4 flex flex-col gap-4 max-w-6xl">
      <Card
        title="Tasks"
        labelledBy="nd-tasks"
        action={
          <label className="text-xs flex items-center gap-2">
            <span className={muted}>Show</span>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 rounded-md bg-zinc-800 light:bg-slate-100 border border-white/10 light:border-slate-200 px-2"
            >
              <option value="all">All states</option>
              {DISPLAY_STATES.filter((s) => s.tracked).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        }
      >
        <TaskTable tasks={tasks} now={data.now} linkToInspector={false} />
      </Card>
      <StateLegendCard />
      <CreateTask
        workspaces={data.workspaces}
        onCreated={() => data.refresh()}
      />
    </div>
  );
}

function StateLegendCard() {
  return (
    <Card title="Task states" labelledBy="nd-states">
      <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
        {DISPLAY_STATES.map((s) => (
          <li key={s.id} className="flex items-start gap-2">
            <span
              className={`font-medium min-w-[11rem] ${s.tracked ? "" : muted}`}
            >
              {s.label}
            </span>
            <span className={muted}>
              {s.tracked ? "From the backend state machine" : s.note}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function ApprovalsSection({ data }) {
  return (
    <div className="pt-4 flex flex-col gap-4 max-w-6xl">
      <Card
        title={`Awaiting approval (${data.approvals.length})`}
        labelledBy="nd-approvals"
      >
        <TaskTable
          tasks={data.approvals}
          now={data.now}
          linkToInspector={true}
        />
      </Card>
      <p className={`text-xs ${muted}`}>
        Open a task to inspect the exact operation, its evidence and audit
        history before deciding.
      </p>
    </div>
  );
}

export function LogsSection({ data }) {
  const engines = data.engines?.engines || [];
  return (
    <div className="pt-4 flex flex-col gap-4 max-w-5xl">
      <Card title="Control plane" labelledBy="nd-cp">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className={muted}>Mode</dt>
          <dd>{data.status?.mode}</dd>
          <dt className={muted}>Execution</dt>
          <dd>{data.status?.executionEnabled ? "Enabled" : "Disabled"}</dd>
          <dt className={muted}>Engine process control</dt>
          <dd>
            {data.status?.engineProcessControl
              ? "Enabled"
              : "Disabled (engines are externally owned)"}
          </dd>
          <dt className={muted}>Agents may approve</dt>
          <dd>{data.status?.agentsMayApprove ? "Yes" : "No"}</dd>
          <dt className={muted}>Storage</dt>
          <dd>{data.status?.storage}</dd>
        </dl>
      </Card>
      <Card title="Engine diagnostics (last check)" labelledBy="nd-diag">
        <ul className="flex flex-col gap-3 text-sm">
          {engines.map((e) => (
            <li key={e.id} className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                <span className="font-medium">
                  {ENGINE_NAMES[e.id] || e.id}
                </span>
                <EngineStatus engine={e} />
                {e.lastCheck && (
                  <span className={`text-xs ${muted}`}>
                    {timeAgo(e.lastCheck.checkedAt, data.now)}
                  </span>
                )}
              </span>
              {(e.lastCheck?.diagnostics || []).map((d) => (
                <span
                  key={d.code}
                  className="text-xs font-mono"
                >{`${d.code}: ${d.message}`}</span>
              ))}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Audit" labelledBy="nd-audit-links">
        <p className="text-sm">
          Every task keeps a hash-chained audit log, shown in its approval view.
          {data.role === "admin" && (
            <>
              {" "}
              AnythingLLM's own event log is under{" "}
              <Link className="underline" to="/settings/event-logs">
                Settings → Event logs
              </Link>
              .
            </>
          )}
        </p>
      </Card>
    </div>
  );
}

export function KnowledgeSection({ data }) {
  return (
    <div className="pt-4 flex flex-col gap-4 max-w-4xl">
      <Card title="Knowledge base" labelledBy="nd-kb">
        <p className="text-sm">
          Documents belong to workspaces. Add them from the chat's upload
          button, or manage the vector database in a workspace's settings.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {data.workspaces.map((w) => (
            <li key={w.slug} className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{w.name || w.slug}</span>
              <Link
                className="text-indigo-300 light:text-indigo-700 underline text-xs"
                to={`/workspace/${encodeURIComponent(w.slug)}`}
              >
                Chat and upload
              </Link>
              {["admin", "manager"].includes(data.role) && (
                <Link
                  className="text-indigo-300 light:text-indigo-700 underline text-xs"
                  to={`/workspace/${encodeURIComponent(w.slug)}/settings/vector-database`}
                >
                  Vector database settings
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function MemoriesSection({ data }) {
  return (
    <div className="pt-4 flex flex-col gap-4 max-w-4xl">
      <Card title="Memories" labelledBy="nd-mem">
        <p className="text-sm">
          Memories are managed per workspace in the chat's Memories panel.
          NyteDesk does not keep a separate memory store.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {data.workspaces.map((w) => (
            <li key={w.slug}>
              <Link
                className="text-indigo-300 light:text-indigo-700 underline"
                to={`/workspace/${encodeURIComponent(w.slug)}`}
              >
                {w.name || w.slug}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
