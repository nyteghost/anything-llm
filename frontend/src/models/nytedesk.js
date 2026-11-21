import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

/**
 * NyteDesk API client. Mutations carry an Idempotency-Key chosen by the
 * caller, so a retried click returns the stored result instead of acting twice.
 */
function newIdempotencyKey() {
  return `nd-${window.crypto.randomUUID()}`;
}

async function request(method, path, { body, key } = {}) {
  const headers = { ...baseHeaders(), "Content-Type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    const error = res.ok ? null : data?.error || `HTTP ${res.status}`;
    return { ok: res.ok, status: res.status, data, error };
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: e.message };
  }
}

function query(params = {}) {
  const entries = Object.entries(params).filter(([, v]) => v);
  const q = new URLSearchParams(entries).toString();
  return q ? `?${q}` : "";
}

const taskPath = (task, op) =>
  `/nytedesk/tasks/${encodeURIComponent(task.id)}/${op}`;

const NyteDesk = {
  newIdempotencyKey,
  status: () => request("GET", "/nytedesk/status"),
  agents: () => request("GET", "/nytedesk/agents"),
  workspaces: () => request("GET", "/nytedesk/workspaces"),
  tasks: (params = {}) => request("GET", `/nytedesk/tasks${query(params)}`),
  approvals: () => request("GET", "/nytedesk/approvals"),
  task: (id) => request("GET", `/nytedesk/tasks/${encodeURIComponent(id)}`),
  createTask: (slug, body, key) => {
    const path = `/nytedesk/workspaces/${encodeURIComponent(slug)}/tasks`;
    return request("POST", path, { body, key });
  },
  decide: (task, decision, reason, key) => {
    const body = {
      expectedVersion: task.version,
      payloadHash: task.payloadHash,
      reason: reason || null,
    };
    return request("POST", taskPath(task, decision), { body, key });
  },
  cancel: (task, reason, key) => {
    const body = { expectedVersion: task.version, reason: reason || null };
    return request("POST", taskPath(task, "cancel"), { body, key });
  },
  telemetry: () => request("GET", "/nytedesk/telemetry"),
  engines: () => request("GET", "/nytedesk/engines"),
  saveEngine: (id, body, key) => {
    const path = `/nytedesk/engines/${encodeURIComponent(id)}`;
    return request("PUT", path, { body, key });
  },
  checkEngine: (id) => {
    const path = `/nytedesk/engines/${encodeURIComponent(id)}/check`;
    return request("POST", path);
  },
  selectEngine: (engineId, expectedSelectionId, key) => {
    const body = { engineId, expectedSelectionId };
    return request("PUT", "/nytedesk/engine-selection", { body, key });
  },
  providers: () => request("GET", "/nytedesk/providers"),
  saveProvider: (id, body, key) => {
    const path = `/nytedesk/providers/${encodeURIComponent(id)}`;
    return request("PUT", path, { body, key });
  },
};

export default NyteDesk;
