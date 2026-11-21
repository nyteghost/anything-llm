import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle,
  Lightning,
  ShieldWarning,
  XCircle,
} from "@phosphor-icons/react";
import NyteDesk from "@/models/nytedesk";
import showToast from "@/utils/toast";
import {
  ACTION_INFO,
  MODEL_CONTROL_ACTIONS,
  createSequencer,
  describeAdapter,
  modelOutcome,
  provenance,
  reviewBinding,
  reviewMatches,
  riskLevel,
} from "@/utils/nytedesk/taskState";
import { Badge, Card, StateBadge, muted } from "./ui";

/**
 * Everything a person needs to decide one task, from the server's task record
 * and audit log. The server decides who may approve (role, protected actions,
 * no self-approval, payload hash, version); this view only explains it and
 * sends the reviewed payload hash and version with the decision.
 */
export default function ApprovalInspector({
  taskId,
  user,
  onChanged,
  backTo = "approvals",
}) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState("");
  // The exact task revision the person confirmed; see reviewBinding().
  const [reviewedFor, setReviewedFor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState(() => newKeys());
  const sequencer = useRef(createSequencer());

  // Loads are sequenced: only the newest request may update the view, so a
  // slow response for a task the person already left is dropped.
  const load = useCallback(async () => {
    const token = sequencer.current.begin();
    const r = await NyteDesk.task(taskId);
    if (!sequencer.current.isCurrent(token)) return;
    if (!r.ok) {
      setError(
        r.status === 404
          ? "This task does not exist or is in a workspace you cannot access."
          : r.error
      );
      setDetail(null);
      return;
    }
    if (r.data?.task?.id !== taskId) return;
    setError(null);
    setDetail(r.data);
  }, [taskId]);

  // A different task starts from a clean slate: nothing reviewed, no reason,
  // fresh idempotency keys, and no data from the previous task on screen.
  useEffect(() => {
    setDetail(null);
    setError(null);
    setReviewedFor(null);
    setReason("");
    setKeys(newKeys());
    load();
  }, [taskId, load]);

  // Coming back to the window reloads the task; if it changed meanwhile, its
  // new version or hash voids the earlier confirmation automatically.
  useEffect(() => {
    const onFocus = () => {
      if (!document.hidden) load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);

  if (error) {
    return (
      <Card>
        <BackLink to={backTo} />
        <p className="text-sm text-red-300" role="alert">
          {error}
        </p>
      </Card>
    );
  }
  if (!detail || detail.task.id !== taskId) {
    return <p className={`pt-4 text-sm ${muted}`}>Loading task…</p>;
  }

  const { task, audit, auditVerified, auditProblems } = detail;
  const info = ACTION_INFO[task.action] || {
    label: task.action,
    scope: "Unknown",
  };
  const risk = riskLevel(detail.protected);
  const target = describeAdapter(task.adapter);
  const blocked = decisionBlocker(detail, user);
  const reviewed = reviewMatches(reviewedFor, task);
  const isModelTask = MODEL_CONTROL_ACTIONS.includes(task.action);
  const outcome = isModelTask ? modelOutcome(audit) : null;
  const operationLabel =
    task.action === "engine.model.load"
      ? `Load ${task.target} now`
      : `Unload ${task.target} now`;

  // Run an approved model load/unload. The server re-checks the approval,
  // the engine and the model state first; the version prevents a second run.
  const runModel = async () => {
    if (task.id !== taskId || !detail.canRun) return;
    setBusy(true);
    const r = await NyteDesk.runModelTask(task);
    setBusy(false);
    if (!r.ok) {
      showToast(r.error, "error");
    } else {
      const ok = r.data?.task?.status === "succeeded";
      showToast(
        ok
          ? "The engine confirmed the operation"
          : "The operation failed; see the evidence",
        ok ? "success" : "error"
      );
    }
    await load();
    onChanged?.();
  };

  const act = async (op) => {
    // Approval needs a confirmation of exactly this revision, never an older one.
    if (op === "approve" && !reviewMatches(reviewedFor, task)) return;
    if (task.id !== taskId) return;
    setBusy(true);
    const r =
      op === "cancel"
        ? await NyteDesk.cancel(task, reason, keys.cancel)
        : await NyteDesk.decide(task, op, reason, keys[op]);
    setBusy(false);
    if (r.status !== 0) setKeys(newKeys());
    if (!r.ok) {
      showToast(
        r.status === 409
          ? `${r.error}. The task was reloaded; review it again.`
          : r.error,
        "error"
      );
      setReviewedFor(null);
      await load();
      return;
    }
    showToast(
      op === "approve" ? "Approved" : op === "deny" ? "Rejected" : "Cancelled",
      "success"
    );
    setReviewedFor(null);
    setReason("");
    await load();
    onChanged?.();
  };

  return (
    <div className="flex flex-col gap-4 max-w-5xl pt-4">
      <BackLink to={backTo} />
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{info.label}</h2>
        <StateBadge status={task.status} />
        <Badge
          tone={detail.protected ? "danger" : "warning"}
        >{`${risk.level} risk`}</Badge>
        <span className={`text-xs font-mono ${muted} break-all`}>
          {task.id}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Exact proposed operation"
          labelledBy="nd-op"
          className="lg:col-span-2"
        >
          <pre className="whitespace-pre-wrap break-words text-sm font-sans rounded-lg bg-black/20 light:bg-slate-50 border border-white/10 light:border-slate-200 p-3">
            {task.description}
          </pre>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className={muted}>Action</dt>
            <dd className="font-mono">{task.action}</dd>
            <dt className={muted}>Addressed to</dt>
            <dd>{`${target.name} (${target.role})`}</dd>
            {task.target && (
              <>
                <dt className={muted}>Model</dt>
                <dd className="font-mono break-all">{task.target}</dd>
              </>
            )}
            <dt className={muted}>Workspace</dt>
            <dd>{task.workspaceSlug || `#${task.workspaceId}`}</dd>
            <dt className={muted}>Task version</dt>
            <dd>{task.version}</dd>
          </dl>
        </Card>

        <Card title="Requester and provenance" labelledBy="nd-prov">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            {provenance(task, audit).map((p) => (
              <Row key={p.label} label={p.label} value={p.value} at={p.at} />
            ))}
          </dl>
          <p className={`text-xs ${muted}`}>
            Tasks are requested by signed-in users. A request from an agent
            arrives through a user and is shown under that user.
          </p>
        </Card>

        <Card title="Affected resources and files" labelledBy="nd-res">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className={muted}>Scope</dt>
            <dd>{info.scope}</dd>
            <dt className={muted}>Workspace</dt>
            <dd>{task.workspaceSlug || `#${task.workspaceId}`}</dd>
            <dt className={muted}>Files</dt>
            <dd>None declared. Tasks do not carry a file list yet.</dd>
          </dl>
        </Card>

        <Card title="Risk and permissions" labelledBy="nd-risk">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className={muted}>Risk level</dt>
            <dd>{risk.level}</dd>
            <dt className={muted}>Who may approve</dt>
            <dd>{risk.approver}</dd>
            <dt className={muted}>Permission requested</dt>
            <dd>{info.label}</dd>
            <dt className={muted}>Execution</dt>
            <dd>
              {!isModelTask
                ? "Disabled. Approval records the decision; nothing runs."
                : detail.modelControl
                  ? "Model control is on. After approval, a manager or administrator who is not the requester runs it; NyteDesk re-checks the approval and the engine first."
                  : "Disabled. Model control is off on this server."}
            </dd>
            <dt className={muted}>Approval validity</dt>
            <dd>Bound to this payload hash, expires after 24 hours</dd>
          </dl>
        </Card>

        <Card title="Supporting evidence" labelledBy="nd-evidence">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className={muted}>Payload hash</dt>
            <dd className="font-mono break-all">{task.payloadHash}</dd>
            <dt className={muted}>Audit chain</dt>
            <dd
              className={
                auditVerified
                  ? "text-emerald-300 light:text-emerald-700"
                  : "text-red-300"
              }
            >
              {auditVerified
                ? "Verified"
                : `FAILED: ${auditProblems.join("; ")}`}
            </dd>
            {outcome ? (
              <>
                <dt className={muted}>Outcome</dt>
                <dd
                  className={
                    outcome.succeeded
                      ? "text-emerald-300 light:text-emerald-700"
                      : "text-red-300"
                  }
                >
                  {`${outcome.succeeded ? "Confirmed" : "Failed"} (${outcome.code})${outcome.message ? `: ${outcome.message}` : ""}`}
                </dd>
                <dt className={muted}>Engine answer</dt>
                <dd>{`HTTP ${outcome.httpStatus ?? "none"} in ${outcome.durationMs ?? "?"} ms`}</dd>
                <dt className={muted}>Loaded before</dt>
                <dd className="font-mono break-all">
                  {(outcome.loadedBefore || []).join(", ") || "none"}
                </dd>
                <dt className={muted}>Loaded after</dt>
                <dd className="font-mono break-all">
                  {outcome.loadedAfter === null
                    ? "could not be read"
                    : (outcome.loadedAfter || []).join(", ") || "none"}
                </dd>
              </>
            ) : (
              <>
                <dt className={muted}>Attachments</dt>
                <dd>None. Tasks do not store evidence records yet.</dd>
              </>
            )}
          </dl>
        </Card>

        <Card
          title="Audit history"
          labelledBy="nd-audit"
          className="lg:col-span-2"
        >
          <ol className="flex flex-col gap-1 text-xs font-mono">
            {audit.map((e) => (
              <li key={e.sequence} className="flex flex-wrap gap-x-3">
                <span className={muted}>{e.sequence}.</span>
                <span>{e.at}</span>
                <span>{e.event}</span>
                <span>{`user #${e.actorId} (${e.actorRole})`}</span>
                <span className={`${muted} break-all`}>
                  {e.hash?.slice(0, 16)}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card title="Decision" labelledBy="nd-decision">
        {blocked ? (
          <p className="text-sm flex gap-2 items-start" role="status">
            <ShieldWarning
              size={18}
              className="text-amber-300 shrink-0"
              aria-hidden="true"
            />
            {blocked}
          </p>
        ) : (
          <>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) =>
                  setReviewedFor(e.target.checked ? reviewBinding(task) : null)
                }
                className="mt-1"
              />
              <span>
                I reviewed the exact operation above and the payload hash ending{" "}
                <span className="font-mono">{task.payloadHash.slice(-12)}</span>
                .
              </span>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className={muted}>Reason (recorded in the audit log)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
                className="min-h-[64px] rounded-lg bg-zinc-800 light:bg-slate-50 border border-white/10 light:border-slate-200 p-2 text-sm"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!reviewed || busy}
                onClick={() => act("approve")}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-3 py-1.5"
              >
                <CheckCircle size={16} aria-hidden="true" /> Approve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => act("deny")}
                className="flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-sm font-medium px-3 py-1.5"
              >
                <XCircle size={16} aria-hidden="true" /> Reject
              </button>
            </div>
            {!reviewed && (
              <p className={`text-xs ${muted}`}>
                Confirm the review to enable Approve.
              </p>
            )}
          </>
        )}
        {detail.canRun && (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={runModel}
              className="self-start flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-sm font-medium px-3 py-1.5"
            >
              <Lightning size={16} aria-hidden="true" />
              {busy ? "Working…" : operationLabel}
            </button>
            <p className={`text-xs ${muted}`}>
              Approved. NyteDesk re-checks the approval, the engine and the
              model state, then sends one request to the running engine. The
              engine itself is never started or stopped.
            </p>
          </div>
        )}
        {isModelTask &&
          task.status === "approved" &&
          detail.modelControl &&
          !detail.canRun &&
          detail.runBlockedReason && (
            <p className={`text-sm ${muted}`}>
              {`Run unavailable: ${detail.runBlockedReason}.`}
            </p>
          )}
        {isModelTask &&
          task.status === "running" &&
          (detail.operationInFlight ? (
            <p className="text-sm" role="status">
              The request has been sent to the engine and is in flight.
              Cancelling is refused until the engine answers; its outcome will
              be recorded here either way.
            </p>
          ) : (
            <p className="text-sm" role="status">
              No live request owns this task, for example after a server
              restart. Cancelling only closes the task for the record: it cannot
              undo anything the engine may already have done. Check the
              engine&apos;s loaded models before proposing another operation.
            </p>
          ))}
        {detail.canCancel && (
          <button
            type="button"
            disabled={busy}
            onClick={() => act("cancel")}
            className="self-start text-xs underline text-zinc-300 light:text-slate-600 disabled:opacity-40"
          >
            Cancel this task
          </button>
        )}
      </Card>
    </div>
  );
}

function newKeys() {
  return {
    approve: NyteDesk.newIdempotencyKey(),
    deny: NyteDesk.newIdempotencyKey(),
    cancel: NyteDesk.newIdempotencyKey(),
  };
}

/** Why this person cannot decide, or null. Mirrors the server, which decides. */
export function decisionBlocker(detail, user) {
  const { task } = detail;
  if (task.status !== "waiting_approval")
    return "This task is not awaiting approval.";
  if (user && Number(user.id) === Number(task.requesterId)) {
    return "You requested this task. Someone else must approve or reject it.";
  }
  if (detail.canDecide) return null;
  if (detail.protected && user?.role === "manager") {
    return "This is a protected action. Only an administrator may approve or reject it.";
  }
  return "Your role cannot approve or reject tasks. A manager or administrator must decide.";
}

function Row({ label, value, at }) {
  return (
    <>
      <dt className={muted}>{label}</dt>
      <dd>
        {value}
        {at && <span className={muted}>{` · ${at}`}</span>}
      </dd>
    </>
  );
}

function BackLink({ to }) {
  return (
    <Link
      to={`/nytedesk/${to}`}
      className="self-start text-xs flex items-center gap-1 text-indigo-300 light:text-indigo-700 hover:underline"
    >
      <ArrowLeft size={12} aria-hidden="true" />{" "}
      {to === "tasks" ? "All tasks" : "All approvals"}
    </Link>
  );
}
