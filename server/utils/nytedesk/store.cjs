"use strict";

/**
 * NyteDesk persistent task and audit store.
 *
 * A separate SQLite database (node:sqlite, no npm dependency) in
 * STORAGE_DIR/nytedesk/nytedesk.db. It never opens, migrates or writes the
 * AnythingLLM Prisma database or any user data.
 *
 * Guarantees, each enforced in SQL as well as in code:
 * - Atomic transitions: every change runs in BEGIN IMMEDIATE and updates the
 *   task with a compare-and-swap on its version. A lost race changes nothing
 *   and reports 409.
 * - Immutable payload: triggers reject any UPDATE of a task's payload columns
 *   and any DELETE of a task.
 * - Immutable approval binding: an approval records the payload hash it was
 *   given, the decision ID and an expiry. Once set, triggers reject changing
 *   it. One decision per task (UNIQUE).
 * - Replay protection: decision IDs are server-generated and unique; a decided
 *   task cannot be decided again; idempotency keys return the stored result
 *   for the same request and refuse a different request under the same key.
 * - Audit: append-only (triggers reject UPDATE and DELETE), SHA-256
 *   hash-chained per task, continuity checked against the task version.
 *
 * Execution is not available: `startTask` refuses unless the caller passes
 * `executionEnabled: true`, which no HTTP route does.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("./control-plane.cjs");

const ZERO = "0".repeat(64);
const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const MAX_AUDIT_EVENTS = 128;

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
  // Suppress only the experimental-feature warning node:sqlite emits on Node 22.
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (/SQLite is an experimental feature/.test(String(text))) return;
    return original.call(process, warning, ...rest);
  };
  try {
    return require("node:sqlite");
  } catch {
    throw new NyteDeskError(
      503,
      "NyteDesk storage needs Node.js with node:sqlite (Node 22.5 or later)"
    );
  } finally {
    process.emitWarning = original;
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
  BEFORE UPDATE OF id, workspace_id, workspace_slug, requester_id, adapter,
    action, description, payload_hash, created_at ON tasks
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

const SQL = Object.freeze({
  task: "SELECT * FROM tasks WHERE id = ?",
  insertTask: `INSERT INTO tasks (id, workspace_id, workspace_slug,
    requester_id, adapter, action, description, payload_hash, status, version,
    approval_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  casTask: `UPDATE tasks SET status = ?, version = ?, updated_at = ?
    WHERE id = ? AND version = ?`,
  casTaskApproval: `UPDATE tasks SET status = ?, version = ?, updated_at = ?,
    approval_json = ? WHERE id = ? AND version = ?`,
  lastAudit: `SELECT sequence, hash FROM audit WHERE task_id = ?
    ORDER BY sequence DESC LIMIT 1`,
  countAudit: "SELECT COUNT(*) AS n FROM audit WHERE task_id = ?",
  insertAudit: `INSERT INTO audit (task_id, sequence, event, actor_id,
    actor_role, at, detail_json, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  audit: "SELECT * FROM audit WHERE task_id = ? ORDER BY sequence",
  insertDecision: `INSERT INTO decisions (decision_id, task_id, actor_id,
    decision, payload_hash, at) VALUES (?, ?, ?, ?, ?, ?)`,
  decision: "SELECT * FROM decisions WHERE task_id = ?",
  idempotency: `SELECT request_hash, status, response_json FROM idempotency
    WHERE actor_id = ? AND key = ?`,
  insertIdempotency: `INSERT INTO idempotency (actor_id, key, request_hash,
    status, response_json, at) VALUES (?, ?, ?, ?, ?, ?)`,
  providers: "SELECT * FROM providers ORDER BY id",
  providerVersion: "SELECT version FROM providers WHERE id = ?",
  updateProvider: `UPDATE providers SET kind = ?, base_url = ?, model = ?,
    key_env = ?, version = ?, updated_by = ?, updated_at = ?
    WHERE id = ? AND version = ?`,
  insertProvider: `INSERT INTO providers (id, kind, base_url, model, key_env,
    version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
});

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

/** The pure state-machine view of a stored task (identities as strings). */
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

function auditHash(row) {
  const entry = {
    task_id: row.task_id,
    sequence: Number(row.sequence),
    event: row.event,
    actor_id: Number(row.actor_id),
    actor_role: row.actor_role,
    at: row.at,
    detail: JSON.parse(row.detail_json),
    prev_hash: row.prev_hash,
  };
  return sha256(cp.canonical(entry));
}

function genesis(taskId) {
  return sha256(`${ZERO}:${taskId}`);
}

function clip(text) {
  return typeof text === "string" ? text.slice(0, 1000) : null;
}

function mapError(error) {
  const message = error.message;
  if (/Stale task version/.test(message)) {
    return new NyteDeskError(409, "Stale task version; reload and retry");
  }
  if (/self-approve/.test(message)) return new NyteDeskError(403, message);
  return new NyteDeskError(409, message);
}

function openStore(options = {}) {
  const { DatabaseSync } = loadSqlite();
  const file = options.file ?? defaultFile();
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  const now = options.now ?? (() => new Date().toISOString());
  const uuid = options.uuid ?? crypto.randomUUID;
  const ttl = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const sql = (name) => db.prepare(SQL[name]);

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  function getTaskRow(id) {
    return sql("task").get(String(id));
  }

  function appendAudit(taskId, sequence, event, actor, at, detail = {}) {
    const last = sql("lastAudit").get(taskId);
    const expected = last ? Number(last.sequence) + 1 : 1;
    if (expected !== sequence) {
      throw new NyteDeskError(409, "Audit sequence is not continuous");
    }
    const count = Number(sql("countAudit").get(taskId).n);
    if (count >= MAX_AUDIT_EVENTS) {
      throw new NyteDeskError(409, "Task audit capacity reached");
    }
    const row = {
      task_id: taskId,
      sequence,
      event,
      actor_id: Number(actor.id),
      actor_role: String(actor.role),
      at,
      detail_json: JSON.stringify(detail),
      prev_hash: last ? last.hash : genesis(taskId),
    };
    row.hash = auditHash(row);
    sql("insertAudit").run(
      row.task_id,
      row.sequence,
      row.event,
      row.actor_id,
      row.actor_role,
      row.at,
      row.detail_json,
      row.prev_hash,
      row.hash
    );
  }

  /** Compare-and-swap the mutable task columns. Exactly one row must change. */
  function casUpdate(task, next, approvalJson) {
    const values = [next.status, next.nextSequence, next.updatedAt];
    const result =
      approvalJson === undefined
        ? sql("casTask").run(...values, task.id, task.version)
        : sql("casTaskApproval").run(
            ...values,
            approvalJson,
            task.id,
            task.version
          );
    if (Number(result.changes) !== 1) {
      throw new NyteDeskError(
        409,
        "Task changed concurrently; reload and retry"
      );
    }
  }

  function machineTransition(task, args) {
    try {
      return cp.transition(toMachine(task), args, { now });
    } catch (error) {
      throw mapError(error);
    }
  }

  function requireTask(id) {
    const task = rowToTask(getTaskRow(id));
    if (!task) throw new NyteDeskError(404, "Task not found");
    return task;
  }

  /**
   * Run `fn` inside one transaction with idempotency. A stored result for
   * (actor, key) with the same request hash is returned unchanged
   * (replayed: true); a different request under the same key is 409. Only
   * successful results are stored, so a refused request can be corrected and
   * retried.
   */
  function idempotent(actorId, key, requestHash, fn) {
    if (typeof key !== "string" || !IDEMPOTENCY_KEY_RE.test(key)) {
      throw new NyteDeskError(
        400,
        "An Idempotency-Key header (8-128 of A-Z a-z 0-9 _ . : -) is required"
      );
    }
    return tx(() => {
      const prior = sql("idempotency").get(Number(actorId), key);
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new NyteDeskError(
            409,
            "Idempotency-Key was already used for a different request"
          );
        }
        const body = JSON.parse(prior.response_json);
        return { status: Number(prior.status), body, replayed: true };
      }
      const out = fn();
      sql("insertIdempotency").run(
        Number(actorId),
        key,
        requestHash,
        out.status,
        JSON.stringify(out.body),
        now()
      );
      return { ...out, replayed: false };
    });
  }

  const store = {
    file,
    NyteDeskError,

    /** Inside a transaction: create a waiting task and its first audit event. */
    insertTask({ workspace, actor, description, adapter, action }) {
      let machine;
      try {
        const fields = {
          workspaceId: String(workspace.id),
          requesterId: String(actor.id),
          description,
          adapter,
          action,
        };
        machine = cp.createTask(fields, { now, uuid });
      } catch (error) {
        throw new NyteDeskError(400, error.message);
      }
      sql("insertTask").run(
        machine.id,
        Number(workspace.id),
        String(workspace.slug),
        Number(actor.id),
        adapter,
        action,
        description,
        machine.payloadHash,
        machine.status,
        machine.nextSequence,
        machine.createdAt,
        machine.updatedAt
      );
      const detail = { adapter, action, payloadHash: machine.payloadHash };
      const at = machine.createdAt;
      appendAudit(machine.id, 1, "task.created", actor, at, detail);
      return rowToTask(getTaskRow(machine.id));
    },

    /** Inside a transaction: approve or deny, bound to the named payload hash. */
    decideTask(id, actor, { decision, expectedVersion, payloadHash, reason }) {
      const task = requireTask(id);
      if (!["approve", "deny"].includes(decision)) {
        throw new NyteDeskError(400, "Unknown decision");
      }
      const decisionId = uuid();
      const next = machineTransition(task, {
        operation: decision,
        actorId: String(actor.id),
        expectedSequence: expectedVersion,
        decisionId,
        approvedPayloadHash: payloadHash,
      });
      const at = next.updatedAt;
      const expiresAt =
        decision === "approve"
          ? new Date(Date.parse(at) + ttl).toISOString()
          : null;
      const approval = {
        decisionId,
        decision,
        by: Number(actor.id),
        role: String(actor.role),
        payloadHash: task.payloadHash,
        at,
        expiresAt,
        reason: clip(reason),
      };
      casUpdate(task, next, JSON.stringify(approval));
      sql("insertDecision").run(
        decisionId,
        task.id,
        Number(actor.id),
        decision,
        task.payloadHash,
        at
      );
      const detail = {
        decisionId,
        payloadHash: task.payloadHash,
        reason: approval.reason,
      };
      appendAudit(task.id, task.version, `task.${decision}`, actor, at, detail);
      return rowToTask(getTaskRow(task.id));
    },

    /** Inside a transaction: cancel a waiting, approved or running task. */
    cancelTask(id, actor, { expectedVersion, reason }) {
      const task = requireTask(id);
      const next = machineTransition(task, {
        operation: "cancel",
        actorId: String(actor.id),
        expectedSequence: expectedVersion,
      });
      casUpdate(task, next);
      const detail = { reason: clip(reason) };
      const at = next.updatedAt;
      appendAudit(task.id, task.version, "task.cancel", actor, at, detail);
      return rowToTask(getTaskRow(task.id));
    },

    /**
     * Re-check, immediately before any execution, everything an approval
     * depends on. There is no executor yet; this is the contract a future
     * worker must call inside the same transaction as `startTask`.
     */
    reauthorize(id) {
      const problems = [];
      const task = rowToTask(getTaskRow(id));
      if (!task) return { ok: false, problems: ["task not found"] };
      if (task.status !== cp.STATES.APPROVED) {
        problems.push(`status is ${task.status}, not approved`);
      }
      const a = task.approval;
      if (!a || a.decision !== "approve") {
        problems.push("no approval");
      } else {
        const recomputed = cp.payloadHash(toMachine(task));
        if (
          recomputed !== task.payloadHash ||
          a.payloadHash !== task.payloadHash
        ) {
          problems.push("approval is not bound to this payload");
        }
        const expired =
          !a.expiresAt || Date.parse(now()) >= Date.parse(a.expiresAt);
        if (expired) problems.push("approval expired");
        const d = sql("decision").get(task.id);
        const matches =
          d &&
          d.decision_id === a.decisionId &&
          d.payload_hash === task.payloadHash &&
          d.decision === "approve";
        if (!matches) {
          problems.push("decision record does not match the approval");
        }
        if (Number(a.by) === task.requesterId) {
          problems.push("approver is the requester");
        }
      }
      const v = store.verifyAudit(task.id);
      if (!v.ok) problems.push(...v.problems);
      return { ok: problems.length === 0, problems };
    },

    /** Execution is disabled; only an explicit caller may start a task. */
    startTask(id, actor, { expectedVersion, executionEnabled = false } = {}) {
      if (executionEnabled !== true) {
        throw new NyteDeskError(403, "Task execution is not enabled");
      }
      return tx(() => {
        const r = store.reauthorize(id);
        if (!r.ok) {
          const why = r.problems.join("; ");
          throw new NyteDeskError(409, `Reauthorization failed: ${why}`);
        }
        const task = requireTask(id);
        const next = machineTransition(task, {
          operation: "start",
          actorId: String(actor.id),
          expectedSequence: expectedVersion,
        });
        casUpdate(task, next);
        const at = next.updatedAt;
        appendAudit(task.id, task.version, "task.start", actor, at, {});
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
      const where = status
        ? `workspace_id IN (${marks}) AND status = ?`
        : `workspace_id IN (${marks})`;
      const query = `SELECT * FROM tasks WHERE ${where}
        ORDER BY created_at DESC, id LIMIT ?`;
      const args = status ? [...ids, String(status), lim] : [...ids, lim];
      return db
        .prepare(query)
        .all(...args)
        .map(rowToTask);
    },

    auditFor(id) {
      return sql("audit")
        .all(String(id))
        .map((r) => ({
          sequence: Number(r.sequence),
          event: r.event,
          actorId: Number(r.actor_id),
          actorRole: r.actor_role,
          at: r.at,
          detail: JSON.parse(r.detail_json),
          prevHash: r.prev_hash,
          hash: r.hash,
        }));
    },

    /** Recompute the hash chain; it must be continuous up to the version. */
    verifyAudit(id) {
      const problems = [];
      const task = rowToTask(getTaskRow(id));
      if (!task) return { ok: false, problems: ["task not found"] };
      const rows = sql("audit").all(task.id);
      let prev = genesis(task.id);
      rows.forEach((r, i) => {
        if (Number(r.sequence) !== i + 1) {
          problems.push(`audit sequence gap at ${i + 1}`);
        }
        if (r.prev_hash !== prev) {
          problems.push(`audit ${r.sequence}: previous-hash link broken`);
        }
        if (auditHash(r) !== r.hash) {
          problems.push(`audit ${r.sequence}: hash mismatch`);
        }
        prev = r.hash;
      });
      if (rows.length + 1 !== task.version) {
        problems.push("task version does not follow its audit");
      }
      if (cp.payloadHash(toMachine(task)) !== task.payloadHash) {
        problems.push("task payload does not match its hash");
      }
      const ok = problems.length === 0;
      return { ok, problems, head: prev, events: rows.length };
    },

    listProviders() {
      return sql("providers")
        .all()
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          baseUrl: r.base_url,
          model: r.model,
          keyEnv: r.key_env,
          version: Number(r.version),
          updatedBy: r.updated_by === null ? null : Number(r.updated_by),
          updatedAt: r.updated_at,
        }));
    },

    /** Inside a transaction: upsert a provider with a version check (0 = new). */
    putProvider(id, actor, { kind, baseUrl, model, keyEnv, expectedVersion }) {
      const row = sql("providerVersion").get(id);
      const current = row ? Number(row.version) : 0;
      const stale = "Provider configuration changed; reload and retry";
      if (expectedVersion !== current) throw new NyteDeskError(409, stale);
      const at = now();
      const by = Number(actor.id);
      if (row) {
        const r = sql("updateProvider").run(
          kind,
          baseUrl,
          model,
          keyEnv,
          current + 1,
          by,
          at,
          id,
          current
        );
        if (Number(r.changes) !== 1) throw new NyteDeskError(409, stale);
      } else {
        sql("insertProvider").run(id, kind, baseUrl, model, keyEnv, by, at);
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

module.exports = {
  openStore,
  NyteDeskError,
  IDEMPOTENCY_KEY_RE,
  DEFAULT_APPROVAL_TTL_MS,
  sha256,
};
