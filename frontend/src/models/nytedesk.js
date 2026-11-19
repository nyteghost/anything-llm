import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

/**
 * NyteDesk Phase 1 API client. Mutations carry an Idempotency-Key chosen by the caller, so a
 * retried click returns the stored result instead of acting twice.
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
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : data?.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: e.message };
  }
}

const NyteDesk = {
  newIdempotencyKey,
  status: () => request("GET", "/nytedesk/status"),
  agents: () => request("GET", "/nytedesk/agents"),
  workspaces: () => request("GET", "/nytedesk/workspaces"),
  tasks: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request("GET", `/nytedesk/tasks${q ? `?${q}` : ""}`);
  },
  approvals: () => request("GET", "/nytedesk/approvals"),
  task: (id) => request("GET", `/nytedesk/tasks/${encodeURIComponent(id)}`),
  createTask: (slug, body, key) =>
    request("POST", `/nytedesk/workspaces/${encodeURIComponent(slug)}/tasks`, { body, key }),
  decide: (task, decision, reason, key) =>
    request("POST", `/nytedesk/tasks/${encodeURIComponent(task.id)}/${decision}`, {
      body: { expectedVersion: task.version, payloadHash: task.payloadHash, reason: reason || null },
      key,
    }),
  cancel: (task, reason, key) =>
    request("POST", `/nytedesk/tasks/${encodeURIComponent(task.id)}/cancel`, {
      body: { expectedVersion: task.version, reason: reason || null },
      key,
    }),
  providers: () => request("GET", "/nytedesk/providers"),
  saveProvider: (id, body, key) =>
    request("PUT", `/nytedesk/providers/${encodeURIComponent(id)}`, { body, key }),
};

export default NyteDesk;
