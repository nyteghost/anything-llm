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
  - New `tests/fork/nytedesk-model-control.test.cjs` (13 tests) runs against a stateful fake Ollama. It covers the setting off, proposal validation, refusals (requester, default role, unapproved, agent action, stale version), a successful load/unload with the exact engine calls and payloads, already-loaded and not-loaded, an engine that errors or doesn't change state, concurrency, an expired approval, the immutable target, legacy hash compatibility, and the process route.
  - Updated tests now allow exactly one run route and one run client call.

## Known limits
- The 30-minute keep-alive is fixed in the code.
- The single-operation lock is per server process, not across several servers sharing one database.
- No UI e2e for the new controls yet. The API, store and state machine paths are covered over real HTTP.
- A large model can take longer than the 180 s load timeout. That records `TIMEOUT` and fails the task, even if Ollama finishes loading later. The next load task would then be refused as "already loaded".

## CI evidence at `078ba30`
| Check | Run | Result |
|---|---|---|
| Lint, server and frontend | 44874592021 | ✅ (the first run at `caff5ec` found 2 prettier nits, fixed in `078ba30`) |
| Backend Jest | 44874592033 | ✅ 2570 passed, 5 skipped |
| Fork tests (`focused-tests`) | 44874592113 | ✅ 149/149, 0 skipped |
| Production `vite build` | 44874592113 | ✅ |
| Browser harness | 44874592113 | ✅ |
| Real app in Chrome (`dashboard-e2e`) | 44874592113 | ✅ 32/32 on attempt 3; attempts 1 and 2 failed in the N2 resize step (known **K1** flake) |

**K1 evidence:** rerunning the PR #7 base's own e2e (run 44848801065 at `1d27068`) on 2026-11-21 failed with the identical assertion: focus on the chat `TEXTAREA` after 29 checks. So the flake predates this branch. PR #8 contains the K1 fix (stable `ResizableSplit` structure) and still needs independent re-review.

## Owner verification (when the review is done)
These steps use the same VM procedure as `NYTEDESK_OWNER_VERIFICATION.md` (tunnels, launcher, users).
1. Launch **without** `NYTEDESK_MODEL_CONTROL`. Check:
   - the propose form refuses a model task with "Model control is disabled";
   - the inspector's Execution row says it is off.
2. Stop the launcher. Start it again with `export NYTEDESK_MODEL_CONTROL=true`.
3. Run an Ollama Check. Then, as `qa-default`, propose `engine.model.load` for a **small** model (for example `qwen2.5-coder:0.5b-base`).
4. As `qa-manager`, approve it. As the admin, open the task: a "Load *model* now" button appears. `qa-default` (the requester) does not see it.
5. Click it. On the desktop, `curl -s http://127.0.0.1:11434/api/ps` lists the model, and VRAM rises. The inspector shows Outcome "Confirmed (OK)" with the before/after lists. The audit shows `task.start` and then `task.succeed`.
6. Propose, approve and run `engine.model.unload` for the same model. `/api/ps` is empty again, and VRAM returns to the baseline.
7. Check that Strata and PolyStrata cannot be targeted, and that the engine process route still refuses everything.
