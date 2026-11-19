"use strict";

/**
 * NyteDesk persistent task and audit store (Phase 1).
 *
 * A separate SQLite database (node:sqlite, no npm dependency) in
 * STORAGE_DIR/nytedesk/nytedesk.db. It never opens, migrates or writes the
 * AnythingLLM Prisma database or any user data.
 *
 * Guarantees, each enforced in SQL as well as in code:
 * - Atomic transitions: every change runs in BEGIN IMMEDIATE and updates the task with a
 *   compare-and-swap on its version (`WHERE id = ? AND version = ?`). A lost race changes
 *   nothing and reports 409.
 * - Immutable payload: triggers reject any UPDATE of a task's payload columns or DELETE of a task.
 * - Immutable approval binding: an approval records the payload hash it was given, the decision
 *   ID and an expiry. Once set, triggers reject changing it. One decision per task (UNIQUE).
 * - Replay protection: decision IDs are server-generated and unique; a decided task cannot be
 *   decided again; idempotency keys return the stored result for the same request and refuse
 *   a different request under the same key.
 * - Audit: append-only (triggers reject UPDATE and DELETE), SHA-256 hash-chained per task,
 *   with continuity checked against the task version.
 *
 * Execution is not available in Phase 1: `start` refuses unless the caller passes
 * `executionEnabled: true`, which no HTTP route does.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("./control-plane.cjs");

const ZERO = "0".repeat(64);
const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

class NyteDeskError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function loadSqlite() {
  try {
    // Suppress only the one experimental-feature warning node:sqlite emits on Node 22.
    const original = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      const text = typeof warning === "string" ? warning : warning?.message;
      if (/SQLite is an experimental feature/.test(String(text))) return;
      return original.call(process, warning, ...rest);
    };
    try {
      return require("node:sqlite");
    } finally {
      process.emitWarning = original;
    }
  } catch {
    throw new NyteDeskError(503, "NyteDesk storage needs Node.js with node:sqlite (Node 22.5 or later)");
  }
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  workspace_slug TEXT NOT NULL,
  requester_id INTEGER NOT NULL,
  adapter TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  approval_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
CREATE TRIGGER IF NOT EXISTS tasks_payload_immutable
  BEFORE UPDATE OF id, workspace_id, workspace_slug, requester_id, adapter, action, description, payload_hash, created_at ON tasks
  BEGIN SELECT RAISE(ABORT, 'nytedesk: task payload is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tasks_approval_immutable
  BEFORE UPDATE OF approval_json ON tasks WHEN OLD.approval_json IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'nytedesk: approval binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS tasks_no_delete BEFORE DELETE ON tasks
  BEGIN SELECT RAISE(ABORT, 'nytedesk: tasks are never deleted'); END;
CREATE TABLE IF NOT EXISTS audit (
  task_id TEXT NOT NULL REFERENCES tasks (id),
  sequence INTEGER NOT NULL,
  event TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  actor_role TEXT NOT NULL,
  at TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (task_id, sequence)
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
  BEGIN SELECT RAISE(ABORT, 'nytedesk: audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
  BEGIN SELECT RAISE(ABORT, 'nytedesk: audit is append-only'); END;
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks (id),
  actor_id INTEGER NOT NULL,
  decision TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decisions
  BEGIN SELECT RAISE(ABORT, 'nytedesk: decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions
  BEGIN SELECT RAISE(ABORT, 'nytedesk: decisions are immutable'); END;
CREATE TABLE IF NOT EXISTS idempotency (
  actor_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (actor_id, key)
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  base_url TEXT,
  model TEXT,
  key_env TEXT,
  version INTEGER NOT NULL,
  updated_by INTEGER,
  updated_at TEXT
);
`;

function defaultFile() {
  const root = process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : path.resolve(__dirname, "../../storage");
  return path.join(root, "nytedesk", "nytedesk.db");
}

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: Number(row.workspace_id),
    workspaceSlug: row.workspace_slug,
    requesterId: Number(row.requester_id),
    adapter: row.adapter,
    action: row.action,
    description: row.description,
    payloadHash: row.payload_hash,
    status: row.status,
    version: Number(row.version),
    approval: row.approval_json ? JSON.parse(row.approval_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The pure state-machine view of a stored task (identities as strings, as control-plane uses). */
function toMachine(task) {
  return {
    id: task.id,
    workspaceId: String(task.workspaceId),
    requesterId: String(task.requesterId),
    description: task.description,
    adapter: task.adapter,
    action: task.action,
    status: task.status,
    approval: task.approval,
    payloadHash: task.payloadHash,
    nextSequence: task.version,
    audit: [],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function auditHash(entry) {
  return sha256(cp.canonical({
    task_id: entry.task_id, sequence: entry.sequence, event: entry.event, actor_id: entry.actor_id,
    actor_role: entry.actor_role, at: entry.at, detail: JSON.parse(entry.detail_json), prev_hash: entry.prev_hash,
  }));
}

function openStore(options = {}) {
  const { DatabaseSync } = loadSqlite();
  const file = options.file ?? defaultFile();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  const now = options.now ?? (() => new Date().toISOString());
  const uuid = options.uuid ?? crypto.randomUUID;
  const ttl = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function getTaskRow(id) {
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(String(id));
  }

  function appendAudit(taskId, sequence, event, actor, at, detail = {}) {
    const last = db.prepare("SELECT sequence, hash FROM audit WHERE task_id = ? ORDER BY sequence DESC LIMIT 1").get(taskId);
    if ((last ? Number(last.sequence) + 1 : 1) !== sequence)
      throw new NyteDeskError(409, "Audit sequence is not continuous");
    const count = Number(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE task_id = ?").get(taskId).n);
    if (count >= 128) throw new NyteDeskError(409, "Task audit capacity reached");
    const entry = {
      task_id: taskId, sequence, event, actor_id: Number(actor.id), actor_role: String(actor.role),
      at, detail_json: JSON.stringify(detail), prev_hash: last ? last.hash : sha256(`${ZERO}:${taskId}`),
    };
    entry.hash = auditHash(entry);
    db.prepare(`INSERT INTO audit (task_id, sequence, event, actor_id, actor_role, at, detail_json, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.task_id, entry.sequence, entry.event, entry.actor_id,
      entry.actor_role, entry.at, entry.detail_json, entry.prev_hash, entry.hash);
  }

  /** Compare-and-swap the mutable task columns. Exactly one row must change. */
  function casUpdate(task, next, approvalJson) {
    const result = approvalJson === undefined
      ? db.prepare("UPDATE tasks SET status = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?")
        .run(next.status, next.nextSequence, next.updatedAt, task.id, task.version)
      : db.prepare("UPDATE tasks SET status = ?, version = ?, updated_at = ?, approval_json = ? WHERE id = ? AND version = ?")
        .run(next.status, next.nextSequence, next.updatedAt, approvalJson, task.id, task.version);
    if (Number(result.changes) !== 1) throw new NyteDeskError(409, "Task changed concurrently; reload and retry");
  }

  function machineTransition(task, args) {
    try {
      return cp.transition(toMachine(task), args, { now });
    } catch (error) {
      if (/Stale task version/.test(error.message)) throw new NyteDeskError(409, "Stale task version; reload and retry");
      if (/self-approve/.test(error.message)) throw new NyteDeskError(403, error.message);
      if (/does not match/.test(error.message)) throw new NyteDeskError(409, error.message);
      throw new NyteDeskError(409, error.message);
    }
  }

  /**
   * Run `fn` inside one transaction with idempotency. A stored result for (actor, key) with the same
   * request hash is returned unchanged (replayed: true); a different request under the same key is 409.
   * Only successful results are stored, so a refused request can be corrected and retried.
   */
  function idempotent(actorId, key, requestHash, fn) {
    if (typeof key !== "string" || !IDEMPOTENCY_KEY_RE.test(key))
      throw new NyteDeskError(400, "An Idempotency-Key header (8-128 of A-Z a-z 0-9 _ . : -) is required");
    return tx(() => {
      const prior = db.prepare("SELECT request_hash, status, response_json FROM idempotency WHERE actor_id = ? AND key = ?")
        .get(Number(actorId), key);
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new NyteDeskError(409, "Idempotency-Key was already used for a different request");
        return { status: Number(prior.status), body: JSON.parse(prior.response_json), replayed: true };
      }
      const out = fn();
      db.prepare("INSERT INTO idempotency (actor_id, key, request_hash, status, response_json, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(Number(actorId), key, requestHash, out.status, JSON.stringify(out.body), now());
      return { ...out, replayed: false };
    });
  }

  const store = {
    file,
    NyteDeskError,

    /** Inside a transaction: create a task (status waiting_approval) and its first audit event. */
    insertTask({ workspace, actor, description, adapter, action }) {
      let machine;
      try {
        machine = cp.createTask({
          workspaceId: String(workspace.id), requesterId: String(actor.id), description, adapter, action,
        }, { now, uuid });
      } catch (error) {
        throw new NyteDeskError(400, error.message);
      }
      db.prepare(`INSERT INTO tasks (id, workspace_id, workspace_slug, requester_id, adapter, action, description,
        payload_hash, status, version, approval_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
        .run(machine.id, Number(workspace.id), String(workspace.slug), Number(actor.id), adapter, action, description,
          machine.payloadHash, machine.status, machine.nextSequence, machine.createdAt, machine.updatedAt);
      appendAudit(machine.id, 1, "task.created", actor, machine.createdAt, { adapter, action, payloadHash: machine.payloadHash });
      return rowToTask(getTaskRow(machine.id));
    },

    /** Inside a transaction: approve or deny, bound to the payload hash the decider supplies. */
    decideTask(id, actor, { decision, expectedVersion, payloadHash, reason }) {
      const task = rowToTask(getTaskRow(id));
      if (!task) throw new NyteDeskError(404, "Task not found");
      if (!["approve", "deny"].includes(decision)) throw new NyteDeskError(400, "Unknown decision");
      const decisionId = uuid();
      const next = machineTransition(task, {
        operation: decision, actorId: String(actor.id), expectedSequence: expectedVersion, decisionId,
        approvedPayloadHash: payloadHash,
      });
      const at = next.updatedAt;
      const approval = {
        decisionId, decision, by: Number(actor.id), role: String(actor.role), payloadHash: task.payloadHash, at,
        expiresAt: decision === "approve" ? new Date(Date.parse(at) + ttl).toISOString() : null,
        reason: typeof reason === "string" ? reason.slice(0, 1000) : null,
      };
      casUpdate(task, next, JSON.stringify(approval));
      db.prepare("INSERT INTO decisions (decision_id, task_id, actor_id, decision, payload_hash, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(decisionId, task.id, Number(actor.id), decision, task.payloadHash, at);
      appendAudit(task.id, task.version, `task.${decision}`, actor, at, { decisionId, payloadHash: task.payloadHash, reason: approval.reason });
      return rowToTask(getTaskRow(task.id));
    },

    /** Inside a transaction: cancel a waiting, approved or running task. */
    cancelTask(id, actor, { expectedVersion, reason }) {
      const task = rowToTask(getTaskRow(id));
      if (!task) throw new NyteDeskError(404, "Task not found");
      const next = machineTransition(task, { operation: "cancel", actorId: String(actor.id), expectedSequence: expectedVersion });
      casUpdate(task, next);
      appendAudit(task.id, task.version, "task.cancel", actor, next.updatedAt,
        { reason: typeof reason === "string" ? reason.slice(0, 1000) : null });
      return rowToTask(getTaskRow(task.id));
    },

    /**
     * Re-check, immediately before any execution, everything an approval depends on. Phase 1 has no
     * executor; this is the contract a future worker must call inside the same transaction as `start`.
     */
    reauthorize(id) {
      const problems = [];
      const task = rowToTask(getTaskRow(id));
      if (!task) return { ok: false, problems: ["task not found"] };
      if (task.status !== cp.STATES.APPROVED) problems.push(`status is ${task.status}, not approved`);
      const a = task.approval;
      if (!a || a.decision !== "approve") problems.push("no approval");
      else {
        const recomputed = cp.payloadHash(toMachine(task));
        if (recomputed !== task.payloadHash || a.payloadHash !== task.payloadHash) problems.push("approval is not bound to this payload");
        if (!a.expiresAt || Date.parse(now()) >= Date.parse(a.expiresAt)) problems.push("approval expired");
        const d = db.prepare("SELECT * FROM decisions WHERE task_id = ?").get(task.id);
        if (!d || d.decision_id !== a.decisionId || d.payload_hash !== task.payloadHash || d.decision !== "approve")
          problems.push("decision record does not match the approval");
        if (Number(a.by) === task.requesterId) problems.push("approver is the requester");
      }
      const v = store.verifyAudit(task.id);
      if (!v.ok) problems.push(...v.problems);
      return { ok: problems.length === 0, problems };
    },

    /** Execution is disabled in Phase 1; only a caller that explicitly enables it may start a task. */
    startTask(id, actor, { expectedVersion, executionEnabled = false } = {}) {
      if (executionEnabled !== true) throw new NyteDeskError(403, "Task execution is not enabled in NyteDesk Phase 1");
      return tx(() => {
        const r = store.reauthorize(id);
        if (!r.ok) throw new NyteDeskError(409, `Reauthorization failed: ${r.problems.join("; ")}`);
        const task = rowToTask(getTaskRow(id));
        const next = machineTransition(task, { operation: "start", actorId: String(actor.id), expectedSequence: expectedVersion });
        casUpdate(task, next);
        appendAudit(task.id, task.version, "task.start", actor, next.updatedAt, {});
        return rowToTask(getTaskRow(task.id));
      });
    },

    getTask(id) {
      return rowToTask(getTaskRow(id));
    },

    listTasks({ workspaceIds, status = null, limit = 100 } = {}) {
      const ids = (workspaceIds || []).map(Number).filter(Number.isSafeInteger);
      if (!ids.length) return [];
      const lim = Math.max(1, Math.min(500, Number(limit) || 100));
      const marks = ids.map(() => "?").join(",");
      const rows = status
        ? db.prepare(`SELECT * FROM tasks WHERE workspace_id IN (${marks}) AND status = ? ORDER BY created_at DESC, id LIMIT ?`).all(...ids, String(status), lim)
        : db.prepare(`SELECT * FROM tasks WHERE workspace_id IN (${marks}) ORDER BY created_at DESC, id LIMIT ?`).all(...ids, lim);
      return rows.map(rowToTask);
    },

    auditFor(id) {
      return db.prepare("SELECT * FROM audit WHERE task_id = ? ORDER BY sequence").all(String(id)).map((r) => ({
        sequence: Number(r.sequence), event: r.event, actorId: Number(r.actor_id), actorRole: r.actor_role, at: r.at,
        detail: JSON.parse(r.detail_json), prevHash: r.prev_hash, hash: r.hash,
      }));
    },

    /** Recompute the hash chain and check it is continuous and ends at the task's current version. */
    verifyAudit(id) {
      const problems = [];
      const task = rowToTask(getTaskRow(id));
      if (!task) return { ok: false, problems: ["task not found"] };
      const rows = db.prepare("SELECT * FROM audit WHERE task_id = ? ORDER BY sequence").all(task.id);
      let prev = sha256(`${ZERO}:${task.id}`);
      rows.forEach((r, i) => {
        if (Number(r.sequence) !== i + 1) problems.push(`audit sequence gap at ${i + 1}`);
        if (r.prev_hash !== prev) problems.push(`audit ${r.sequence}: previous-hash link broken`);
        if (auditHash(r) !== r.hash) problems.push(`audit ${r.sequence}: hash mismatch`);
        prev = r.hash;
      });
      if (rows.length + 1 !== task.version) problems.push("task version does not follow its audit");
      if (cp.payloadHash(toMachine(task)) !== task.payloadHash) problems.push("task payload does not match its hash");
      return { ok: problems.length === 0, problems, head: prev, events: rows.length };
    },

    listProviders() {
      return db.prepare("SELECT * FROM providers ORDER BY id").all().map((r) => ({
        id: r.id, kind: r.kind, baseUrl: r.base_url, model: r.model, keyEnv: r.key_env,
        version: Number(r.version), updatedBy: r.updated_by === null ? null : Number(r.updated_by), updatedAt: r.updated_at,
      }));
    },

    /** Inside a transaction: upsert a provider configuration with a version check (0 = new). */
    putProvider(id, actor, { kind, baseUrl, model, keyEnv, expectedVersion }) {
      const row = db.prepare("SELECT version FROM providers WHERE id = ?").get(id);
      const current = row ? Number(row.version) : 0;
      if (expectedVersion !== current) throw new NyteDeskError(409, "Provider configuration changed; reload and retry");
      const at = now();
      if (row) {
        const r = db.prepare(`UPDATE providers SET kind = ?, base_url = ?, model = ?, key_env = ?, version = ?, updated_by = ?, updated_at = ?
          WHERE id = ? AND version = ?`).run(kind, baseUrl, model, keyEnv, current + 1, Number(actor.id), at, id, current);
        if (Number(r.changes) !== 1) throw new NyteDeskError(409, "Provider configuration changed; reload and retry");
      } else {
        db.prepare(`INSERT INTO providers (id, kind, base_url, model, key_env, version, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(id, kind, baseUrl, model, keyEnv, Number(actor.id), at);
      }
      return store.listProviders().find((p) => p.id === id);
    },

    idempotent,
    tx,
    close() {
      db.close();
    },
    /** Test and diagnostics access only; never exposed over HTTP. */
    _db: db,
  };
  return store;
}

module.exports = { openStore, NyteDeskError, IDEMPOTENCY_KEY_RE, DEFAULT_APPROVAL_TTL_MS, sha256 };
