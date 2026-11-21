# NyteDesk: approval-gated model load/unload

**Status:** draft, off by default, needs independent review and then owner verification.

**Branch:** `feature/nytedesk-model-control`, from the PR #7 tip `e26e36a`.

## What it does
NyteDesk can ask an **already running Ollama** to load or unload one named model, through Ollama's own HTTP API. Every operation is a task that goes through the normal approval flow and is recorded in the audit chain.

- **Load:** `POST /api/generate` with `{model, prompt: "", stream: false, keep_alive: "30m"}`. Ollama loads the model without generating text and keeps it loaded for 30 minutes after the last use.
- **Unload:** `POST /api/generate` with `{model, keep_alive: 0, stream: false}`.
- **Verify:** `GET /api/ps` runs before and after the request. A task only *succeeds* when the engine answered 2xx **and** `/api/ps` shows the expected change.

## What it does not do
- It never starts, stops, restarts or kills an engine. `POST /nytedesk/engines/:id/process` still refuses every action.
- It doesn't support Strata, which needs an API key that NyteDesk never stores, or PolyStrata.
- It runs no agent: Claude Code, Codex and AgentBridge execution stay disabled. `POST /nytedesk/tasks/:id/run` refuses every action except `engine.model.load` and `engine.model.unload`.
- It runs no shell, process, VM operation or credential, and never calls `nvidia-smi`.

## Owner decision
On 2026-11-21 the owner chose load/unload through approvals. They also accepted that this is a **narrow engine-control path**, separate from agent execution: it needs no code in the VM and no credentials. So the five agent-execution preconditions (`EXECUTION_PRECONDITIONS`) do not gate it, and they still gate everything else.

## Switching it on
```bash
export NYTEDESK_ENABLED=true
export NYTEDESK_MODEL_CONTROL=true   # default off; the launcher never sets it
tools/linux-run.sh
```
With it off, everything behaves exactly as in the PR #7 owner verification:
- model tasks cannot be proposed (403);
- `run` returns 403;
- the inspector says "Model control is off on this server".

## Flow and rules
1. **Propose:** any user with workspace access proposes the task.
   - Action `engine.model.load` or `engine.model.unload`.
   - Adapter `ollama`.
   - `target`: the model name. It must be in the model list from the last successful Ollama check, and it must match `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`.
   - The target is part of the payload hash. Tasks without a target keep the old hash formula, so existing tasks still verify.
2. **Approve:** unchanged rules.
   - A manager or admin who is not the requester approves.
   - They must name the reviewed payload hash and version.
   - The approval expires after 24 h.
3. **Run:** `POST /nytedesk/tasks/:id/run` with `{expectedVersion}`. It is refused unless all of these hold:
   - `NYTEDESK_MODEL_CONTROL=true`;
   - the action is a model-control action;
   - the actor is a manager or admin and **not the requester**;
   - the version matches;
   - `reauthorize` passes: still approved, the hash is still bound, not expired, the decision record matches, the approver isn't the requester, and the audit chain is intact;
   - no other model operation is running on this server;
   - a **fresh** engine check succeeds and lists the model;
   - `/api/ps` is readable, the model isn't already loaded (for load) and is loaded (for unload).

   Only then is the task moved to `running` (`task.start`) and the single request sent.
4. **Record:** `task.succeed` or `task.fail` goes into the audit chain. The evidence includes:
   - the operation, engine, endpoint and model;
   - the result code and message;
   - the HTTP status and duration;
   - the loaded models before and after.

   The inspector shows it under *Supporting evidence*.

**What the refusals change:** any refusal before step 3's start leaves the task `approved` and sends no load or unload request. After a start, a crash leaves the task `running`; the requester or a manager/admin can still cancel it.

## Files
- **Server:**
  - `control-plane.cjs`: the actions, `target`, and validation.
  - `store.cjs`: an additive `target` column with an immutability trigger, and `finishTask`.
  - `model-control.cjs` (new): the HTTP client. It accepts loopback only, follows no redirects, and has bounded time and size limits.
  - `service.cjs`: `runTask` and `canRun`.
  - `routes.cjs`: the run route.
- **UI:**
  - The propose form gets a model picker fed by the last Ollama check.
  - The inspector gets a model row, honest execution text, the outcome evidence, and a "Load/Unload *model* now" button, shown only when the server reports `canRun`.
- **Tests:**
  - New `tests/fork/nytedesk-model-control.test.cjs` (15 tests) runs against a stateful fake Ollama. It covers the setting off, proposal validation, refusals (requester, default role, unapproved, agent action, stale version), a successful load/unload with the exact engine calls and payloads, already-loaded and not-loaded, an engine that errors or doesn't change state, concurrency, an expired approval, the immutable target, legacy hash compatibility, and the process route.
  - Updated tests now allow exactly one run route and one run client call.

## Known limits
- The 30-minute keep-alive is fixed in the code.
- The single-operation lock is per server process, not across several servers sharing one database.
- No UI e2e for the new controls yet. The API, store and state machine paths are covered over real HTTP.
- A large model can take longer than the 180 s load timeout. That records `TIMEOUT` and fails the task, even if Ollama finishes loading later. The next load task would then be refused as "already loaded".
