# NyteDesk control plane — Phase 1

Branch: `feature/nytedesk-control-plane-phase1`
Base: `feature/archive-source-review`

NyteDesk is a task and approval control plane inside AnythingLLM. In Phase 1 people can propose, review, approve, deny, cancel and audit tasks. **No task is ever executed.** There is no route, UI control or worker that starts a task or calls a model, shell, browser, VM, GitHub or any other network service. The archive source-reading features of the base branch are unchanged.

## Confirmed architecture (owner, 2026-11-19)

| Component | Role | Status in this branch |
|---|---|---|
| Local LLM (Ollama / Strata) | **Coordinator.** Plans tasks, delegates work and summarizes results. It may only **recommend**: it never approves, grants itself permissions, bypasses review or authorizes its own requests | Listed as agents `ollama` and `strata`, with role `coordinator`. Endpoint configuration only; no calls are made |
| AgentBridge | Central orchestration, authorization, task persistence, approvals, evidence and audit | Not yet connected. This branch's store is a **local** approval ledger with the same principles (session identity, CAS, immutable approvals, append-only audit). Linking it to AgentBridge (relay v2 drafts, evidence export) is planned, not implemented |
| Claude Code CLI | Primary implementation agent, inside the VM | Listed as agent `claude-code` (role `implementer`, runtime `vm-cli`). Not invoked |
| OpenAI Codex CLI | Independent review, debugging and secondary development, inside the VM | Listed as agent `codex` (role `reviewer`, runtime `vm-cli`). Not invoked |
| Dedicated VM | Isolated environment for editing, builds, tests and agent execution | No VM access from this branch. Execution is gated on the preconditions below |
| AnythingLLM fork | NyteDesk's interface and foundation | This branch |

Official CLI and API interfaces are used, not browser automation of chat websites.

**Supervised mode is the only mode.**
- Every action needs a human decision from a different, authenticated user.
- Agents are not users. `/nytedesk/status` reports `agentsMayApprove: false`, and every agent reports `mayApprove: false`.
- Protected actions need an administrator:
  - `vm.write`, `vm.execute`;
  - `browser.interact`;
  - `git.push`, `git.merge`;
  - `credential.access`, `privilege.change`;
  - `external.publish`.

**Execution preconditions.** All five must be verified before any execution can be enabled. All are reported **unverified** (`executionPreconditions`), and no code path enables execution:
1. VM isolation inspected and verified;
2. folders and resources shared with the host identified and reviewed;
3. VM snapshots or another recovery mechanism established and tested;
4. bounded execution, resource limits and emergency cancellation configured;
5. credentials protected.

The owner has authorized development operations **inside** the dedicated VM, including installing tools and changing VM-local files. Changes to the host computer, shared folders, other devices or network infrastructure are not authorized. This branch performs none of these operations.

## Implemented in Phase 1

| Part | Where | What it does |
|---|---|---|
| State machine | `server/utils/nytedesk/control-plane.cjs` | Pure states and transitions. A SHA-256 payload hash is computed at creation. Approve/deny require the decider to name that hash, and `start` requires the approval to carry it. Tampered task objects are refused. Audit is never silently truncated. |
| Persistent store | `server/utils/nytedesk/store.cjs` | Separate SQLite database (`node:sqlite`, no new npm dependency) at `STORAGE_DIR/nytedesk/nytedesk.db`. Never touches the AnythingLLM Prisma database. |
| Authorization | `server/utils/nytedesk/service.cjs` | Role and permission rules (below), supervised-mode status, agent catalog with roles, provider configuration validation. |
| HTTP API | `server/utils/nytedesk/routes.cjs`, `server/endpoints/nytedesk.js` | Mounted under `/api/nytedesk`; uses AnythingLLM's `validatedRequest`, session user and `Workspace.getWithUser` / `whereWithUser`. |
| Dashboard | `frontend/src/pages/NyteDesk`, `frontend/src/models/nytedesk.js` | `/settings/nytedesk` (Settings → Tools → NyteDesk). Shows status, agents, task proposal, pending approvals, task history, task detail with verified audit, and provider configuration. |
| Tests | `tests/fork/control-plane.test.cjs`, `nytedesk-api.test.cjs`, `nytedesk-frontend.test.cjs` | State machine; real-HTTP integration against the real routes, service and SQLite store with stub authentication; static dashboard checks. |

### Turning it on

- NyteDesk is **off** unless the server environment has `NYTEDESK_ENABLED=true`. Until then every NyteDesk route returns 403.
- It also requires AnythingLLM **multi-user mode**, because an approval must come from a different, authenticated user. In single-user mode the routes return 403.
- Storage needs Node with `node:sqlite`. That is Node 22.5 or later; the fork launcher and CI use Node 24.

### Authorization rules

Identity comes only from the authenticated AnythingLLM session. No request body field names an actor.

- **Create a task:** any user with access to the workspace.
- **View a task or list tasks:** users with access to its workspace. A task in a workspace you cannot access returns 404.
- **Approve or deny:** a manager or admin with workspace access who is **not the requester**. Protected actions (`vm.write`, `vm.execute`, `browser.interact`, `git.push`, `git.merge`, `credential.access`, `privilege.change`, `external.publish`) need an **admin**. Agents can never decide.
- **Cancel:** the requester, or a manager or admin with workspace access.
- **Provider configuration:** managers and admins can read it; only admins can change it.

### Atomicity, idempotency, binding, replay and audit

- **Atomic transitions.**
  - Each change runs in `BEGIN IMMEDIATE`.
  - The task row is updated by compare-and-swap (`WHERE id = ? AND version = ?`).
  - A lost race, whether in-process or from another connection, returns 409 and changes nothing.
- **Idempotency.**
  - Every mutation needs an `Idempotency-Key` header, scoped to the user.
  - The same key with the same request returns the stored result, with header `Idempotent-Replayed: true`.
  - The same key with a different request returns 409.
  - Only successful results are stored.
- **Immutable approval binding.**
  - An approval records:
    - the server-generated decision ID;
    - the decider, with role;
    - the payload hash the decider named, which must equal the task's;
    - the time;
    - an expiry (24 h).
  - SQLite triggers reject any change to a task's payload columns, any change to an approval once set, and any task deletion.
- **Replay protection.**
  - There is one decision per task, enforced by `UNIQUE(task_id)`.
  - Decision IDs are server-generated and unique.
  - A decided task cannot be decided again.
  - Decision rows are immutable.
- **Audit.**
  - The audit is append-only: triggers reject UPDATE and DELETE.
  - Each entry is SHA-256 hash-chained per task, and continuity is checked against the task version.
  - Task detail shows whether the chain verifies. Tampering that bypasses the triggers is still detected by the chain.
- **Reauthorization contract for future workers.** `store.reauthorize(id)` re-checks, immediately before any execution:
  - status;
  - payload binding;
  - expiry;
  - the decision record;
  - that the approver is not the requester;
  - the audit chain.

  `store.startTask` runs that check inside its transaction, and refuses unless the caller passes `executionEnabled: true`. No HTTP route does.

### Provider configuration

- This is configuration only. Execution stays disabled.
- It covers the cloud model APIs: `anthropic` and `openai`. Local engines (Ollama, Strata, PolyStrata) moved to the Local AI Manager below. The Claude Code and Codex CLIs run inside the VM and are configured there, not here.
- **Keys are never stored.** A request containing `apiKey`, `key`, `token`, `secret`, `password` or similar is rejected. `keyEnv` names an environment variable, which must start with `NYTEDESK_`, that the server owner sets. The API reports only whether it is set.
- **Anthropic and OpenAI:** the base URL is restricted to their official API origins. Configuring them requires `keyEnv`.

### Host telemetry policy (dashboard)

`GET /api/nytedesk/telemetry` returns CPU utilization, CPU count and memory of the host running the NyteDesk server, read from Node's `os` module. Nothing is executed.

- **Who may read it:** managers and administrators only. The service enforces this and returns 403 with no telemetry for every other role. The dashboard does not request it for other roles; it shows "Restricted" instead.
- **Always:** authenticated, behind `NYTEDESK_ENABLED` and multi-user mode, `Cache-Control: no-store`.
- GPU, VRAM, temperature, tokens/s and context usage are reported as unavailable, never estimated.
- **Owner decision (open):** confirm this default, or widen access explicitly.

### Local AI Manager (read-only, external ownership)

Code: `server/utils/nytedesk/local-ai-manager.cjs`, engine methods in `service.cjs`, routes in `routes.cjs`, UI in `frontend/src/pages/NyteDesk/LocalAIEngines.jsx`. Tests: `tests/fork/nytedesk-engines.test.cjs`, `tests/fork/local-ai-manager.test.cjs`.

| Engine | API | Default endpoint |
|---|---|---|
| Ollama | `ollama` (`GET /api/tags`) | `http://127.0.0.1:11434` |
| PolyStrata | OpenAI-compatible (`GET {endpoint}/models`) | none: the owner sets it (the tested port 40537 is not hardcoded) |
| Strata | `ollama` or `openai`, chosen by the owner | none: no endpoint is invented |

- **Configuration (admin only):** endpoint, model, context window (512–4194304), VRAM reserve in MiB (0–262144), and the API kind for Strata. Writes use compare-and-swap on `expectedVersion` and an idempotency key. Secret-named and unknown fields are refused.
- **Endpoint policy:** `http://` only, host `127.0.0.1` or `[::1]`, explicit port ≥ 1024, and no credentials, query, fragment or `..`. Engines stay on the same machine as NyteDesk.
- **Check (manager or admin):** a single `GET` with no proxy, no redirects, a 3 s timeout and a 1 MiB response limit. It never throws. It returns reachability, latency, up to 200 model names, whether the configured model is listed, and coded diagnostics (`NOT_CONFIGURED`, `CONNECTION_REFUSED`, `TIMEOUT`, `REDIRECT_REFUSED`, `HTTP_ERROR`, `RESPONSE_TOO_LARGE`, `INVALID_JSON`, `UNEXPECTED_SHAPE`, `NO_MODELS`, `MODEL_NOT_LISTED`, `INVALID_ENDPOINT` and others). The last result per engine is stored.
- **Selection (admin only):** allowed only after a check of the current endpoint less than 15 minutes old (with a valid timestamp) that reached the engine and, when a model is configured, listed it. One rule (`selectionBlocker`) feeds both the route and the listing's `selectable` and `selectionBlockedReason` fields, so the UI never offers a selection the server would refuse. Selection uses compare-and-swap, so two admins cannot overwrite each other silently. Changing the endpoint invalidates the old check.
- **Model names** reported by an engine are untrusted. Only printable names of at most 256 characters are kept, each once, up to 200.
- **Process control: none.** `POST /nytedesk/engines/:id/process` always returns 403 for every role and action. The module contains no `child_process`, signal or kill code (a test enforces this). Every engine is reported as `ownership: "external"`, `canStart: false`, `canStop: false`. NyteDesk never starts, stops, restarts, unloads or kills an engine, and never matches a process by name.
- The selected engine is a **coordinator only**: its output grants no privileges, and AgentBridge and the approval ledger remain the authority.

## Security review of the original state machine (findings and status)

| # | Finding in the original `control-plane.cjs` | Status |
|---|---|---|
| F1 | Trusted caller-supplied `actorId`; any string could approve | Fixed at the API: identity from the AnythingLLM session; roles and workspace access enforced (`service.cjs`, `routes.cjs`) |
| F2 | Approval not bound to the task payload; a caller could build a different task object with the same version and transition it | Fixed: payload hash at creation, approval must name it, tampered objects refused, payload columns immutable in SQL |
| F3 | `decisionId` was any caller string; no replay protection | Fixed: server-generated decision IDs, one immutable decision per task, idempotency keys |
| F4 | Audit silently truncated to the last 128 events; not tamper-evident | Fixed: no truncation (refuses beyond capacity), durable append-only hash-chained audit |
| F5 | `start` / `succeed` / `fail` callable by any actor; no executor role | Mitigated: no route exposes them; `startTask` needs explicit enablement and reauthorization. An executor role remains future work (L3) |
| F6 | `cancel` by any actor | Fixed at the API: requester or manager/admin only |
| F7 | No approver role or workspace check | Fixed: manager/admin with workspace access; admin for VM write/execute, browser interaction, git push/merge |
| F8 | Approvals never expired | Fixed: 24 h expiry checked by `reauthorize` |
| F9 | In-memory version check only; two holders of the same version could both transition | Fixed: compare-and-swap in a transaction; tested in-process and across two connections |

## Remaining limitations (not done in Phase 1)

- **L1. Build not verified here.** The frontend production build (`yarn build`) and a server start with real Prisma were **not** run: this environment cannot install npm packages. The changed frontend files pass a TypeScript-parser syntax check, the server files pass `node --check`, and the dashboard and routes are covered by the tests above. A local `bash tools/linux-run.sh` build is still needed.
- **L2. Real-session coverage is partial.** `server/__tests__/endpoints/nytedesk/nytedesk.test.js` (Jest, runs in CI) mounts the real `server/endpoints/nytedesk.js` with AnythingLLM's real `validatedRequest` and JWTs. It covers missing, forged and suspended tokens, requester identity, self-approval, workspace isolation, engine process denial, role limits on engine changes, and the feature and multi-user gates. Users, workspaces and settings are mocked, so a server start against real Prisma is still untested.
- **L3. No executor, model call, VM worker or browser worker.** There is no executor role and no cancellation hand-off to a running job.
- **L4. Idempotency records and audit grow without retention.** There is no compaction yet. Each task's audit is capped at 128 events (refused beyond that, never dropped).
- **L5. The audit chain is per task.** It detects edits inside a task's history, but not the removal of a whole task together with its audit by someone with direct file access. An off-host anchor (as in AgentBridge Stage B) would close this.
- **L6. Provider `keyPresent` reveals whether a named environment variable is set** (never its value) to managers and admins.

## Next phases (planned, not implemented)

1. Run the build and the UI on the target machine. Add real-session API tests.
2. Connect the local approval ledger to AgentBridge (relay v2 drafts and evidence export). Record verified execution preconditions as owner-signed evidence.
3. Add an executor role and a worker that calls `reauthorize` and `startTask` inside one transaction. Add prompt-only Ollama/Strata coordinator adapters (recommendations only), with cost, time and output limits.
4. Add the Claude Code and Codex CLI runners inside the VM, behind the preconditions, using their official CLIs.
5. Add Anthropic/OpenAI API adapters, using official APIs only, with opt-in external disclosure.
6. Add separately deployed, separately authenticated VM and browser workers. Each needs:
   - isolation verified against the host, shared folders and LAN;
   - egress allowlists;
   - an emergency stop;
   - human confirmation for destructive or external actions.

No merge, deployment, VM reset, credential use or host change is authorized by this branch.

## Test

```sh
node --test tests/fork/control-plane.test.cjs tests/fork/nytedesk-api.test.cjs tests/fork/nytedesk-frontend.test.cjs
node --test tests/fork/*.test.cjs
```
