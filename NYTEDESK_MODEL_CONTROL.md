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
   - a **fresh** engine check succeeds and lists the model. This task probe is recorded in the task's evidence (`freshCheck`). It is **not** saved as the engine's check, because saved checks are selection evidence for the configured model;
   - `/api/ps` is readable, the model isn't already loaded (for load) and is loaded (for unload).

   Only then is the task moved to `running` (`task.start`) and the single request sent. `startTask` re-runs `reauthorize` and the version check inside its own transaction, immediately before dispatch.

   **Run eligibility in the UI:** the task detail reports `canRun` and `runBlockedReason`, using the same rules plus a read-only `reauthorize`. The inspector hides the run control and shows the reason when a run would be refused, for example "Reauthorization would fail: approval expired". This is advisory; the run path re-checks everything.
4. **Record:** `task.succeed` or `task.fail` goes into the audit chain. The evidence includes:
   - the operation, engine, endpoint and model;
   - the result code and message;
   - the HTTP status and duration;
   - the loaded models before and after.

   The inspector shows it under *Supporting evidence*.

**What the refusals change:** any refusal before step 3's start leaves the task `approved` and sends no load or unload request.

**Cancellation before dispatch (preflight):** the server-wide lock is held for the whole run, but the task is only *owned* once `startTask` succeeds.
- During preflight (the fresh probe and the `/api/ps` read), the task is still `approved`, `operationInFlight` is false, and an authorized cancel succeeds.
- When preflight finishes, `startTask`'s transactional reauthorization refuses to dispatch (409). No load or unload request is sent, and the lock is released.

**Cancellation after dispatch:** from `task.start` until the outcome is recorded, the live operation **owns** the task.
- Cancelling it is refused with 409 ("in flight"), for the requester, managers and admins alike, so the engine's outcome is always recorded as `task.succeed` or `task.fail`.
- The detail reports `operationInFlight: true` and `canCancel: false`. The inspector says that cancelling is refused until the engine answers.
- A `running` task that **no live operation owns** can still be cancelled. That happens when the process crashed or restarted after `task.start`. The inspector says that cancelling only closes the task for the record, cannot undo what the engine may already have done, and that you should check the engine's loaded models.
- Ownership is per server process. Several NyteDesk processes sharing one database are not supported.

**Deadlines:** every engine request has an **elapsed-time** deadline that counts from when the request is made, so a response that trickles bytes cannot extend it:
- fresh probe 3 s (the same default as a manual Check);
- `/api/ps` 5 s;
- load 180 s;
- unload 30 s.

A refused redirect closes the connection immediately instead of draining the body. Response-size limits are unchanged: 1 MiB for the probe, 256 KiB for model control. The operation lock is released on every path (`finally`): success, failure, refusal before dispatch, and an unexpected executor error, which fails the task with `INTERNAL_ERROR` evidence.

**Engine selection evidence:** selection (`selectionBlocker`) now needs a fresh check of the current **endpoint, API style and configured model**. Evidence recorded for any other configuration is rejected.

## Files
- **Server:**
  - `control-plane.cjs`: the actions, `target`, and validation.
  - `store.cjs`: an additive `target` column with an immutability trigger, and `finishTask`.
  - `model-control.cjs` (new): the HTTP client. It accepts loopback only, follows no redirects, and has bounded elapsed time and size limits.
  - `local-ai-manager.cjs`: the read-only GET now has an elapsed deadline and closes refused redirects immediately.
  - `service.cjs`: `runTask`, `runBlocker` (eligibility and reason), live-operation ownership and the cancellation rule, and selection evidence bound to the API and model.
  - `routes.cjs`: the run route.
- **UI:**
  - The propose form gets a model picker fed by the last Ollama check.
  - The inspector gets a model row, honest execution text and the outcome evidence. The "Load/Unload *model* now" button is shown only when the server reports `canRun`; otherwise the inspector shows `runBlockedReason`. It also explains what cancellation can do while the task is `running`.
- **Tests:**
  - New `tests/fork/nytedesk-model-control.test.cjs` (24 tests) runs against a stateful fake Ollama. It covers the setting off, proposal validation, refusals (requester, default role, unapproved, agent action, stale version), a successful load/unload with the exact engine calls and payloads, already-loaded and not-loaded, an engine that errors or doesn't change state, concurrency, an expired approval, the immutable target, legacy hash compatibility, and the process route.
  - It also has the review regression tests:
    - cancel refused while in flight, with the outcome recorded;
    - cancel allowed for a stranded `running` task;
    - cancel during preflight succeeds, and the paused run then refuses to dispatch (no POST) and releases the lock;
    - run eligibility and its reasons, including an expired approval;
    - an executor error fails the task and releases the lock;
    - a task probe for model B doesn't touch the selection evidence for model A, and mismatched evidence is rejected;
    - elapsed deadlines against a trickling local double, which has its own 2.5 s cutoff so a regression fails in seconds instead of hanging;
    - immediate redirect close in both clients;
    - the size limit;
    - loopback-only endpoints;
    - a real legacy database created with the `e26e36a` store (verbatim fixture in `tests/fork/fixtures/nytedesk-e26e36a/`).
  - Updated tests now allow exactly one run route and one run client call.

## Known limits
- The 30-minute keep-alive is fixed in the code.
- The single-operation lock and task ownership are per server process, not across several servers sharing one database.
- No UI e2e for the new controls yet. The API, store and state machine paths are covered over real HTTP.
- A large model can take longer than the 180 s load timeout. That records `TIMEOUT` and fails the task, even if Ollama finishes loading later. The next load task would then be refused as "already loaded".

## CI evidence at `078ba30` (reviewed head `9c7104b`)
| Check | Run | Result |
|---|---|---|
| Lint, server and frontend | 44874592021 | ✅ (the first run at `caff5ec` found 2 prettier nits, fixed in `078ba30`) |
| Backend Jest | 44874592033 | ✅ 2570 passed, 5 skipped |
| Fork tests (`focused-tests`) | 44874592113 | ✅ 149/149, 0 skipped |
| Production `vite build` | 44874592113 | ✅ |
| Browser harness | 44874592113 | ✅ |
| Real app in Chrome (`dashboard-e2e`) | 44874592113 | ✅ 32/32 on attempt 3. Attempts 1 and 2 failed in **different** places; see below |

**Chrome attempts at `078ba30` (corrected 2026-11-21; the earlier summary wrongly put both failures under K1):**
- **Attempt 1** failed at `tests/e2e/nytedesk-dashboard.e2e.cjs:629`, after the resize: focus had landed on the chat `TEXTAREA` instead of the current navigation link. Rerunning the PR #7 lineage (run 44848801065 at `1d27068`) reproduced **that same assertion**, so it predates this branch. This is the known K1 behaviour; PR #8 contains the proposed K1 fix and still needs independent re-review.
- **Attempt 2** failed earlier, at line 609, **before any resize**: it timed out after 30 s waiting for the mobile Navigation dialog to appear. Its cause is **unverified**. There's no evidence yet that it is K1 or that it predates this branch.
- **Attempt 3** passed 32/32.

The review fixes since `9c7104b` have not been through CI; they are local only.

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

## Owner verification at `643c51c` (owner run, 2026-11-22)
The owner ran every step on the dedicated VM. The checkout was confirmed at `643c51cb42d83eaea642017555e40f0933ca0eb5` with `git rev-parse HEAD`, and the PR #7 database was migrated in place. Engine evidence comes from the desktop Ollama's own `[GIN]` request log, filtered by time window.

**Users:**
- `adminyte` #1, admin: runner;
- `qa-manager` #2, manager: approver;
- `qa-default` #3, default: requester;
- `qa-default2`, default: wrong-role check.

**Model:** `qwen2.5-coder:0.5b-base` (Q8_0, 717 MB VRAM).

| Check | Result |
|---|---|
| Setting unset: proposal refused, inspector says off, run refused (403), no engine request | ✅ |
| Not approved: run refused (409), no engine request | ✅ |
| Requester runs own task: inspector reason, 403, no engine request | ✅ |
| Default role: inspector reason, 403, no engine request | ✅ |
| Load: `/api/ps` empty → model loaded (expires +30 min); VRAM 2253 → 3226 MiB; log `GET /api/tags` → `GET /api/ps` → **one** `POST /api/generate` (200, 1.26 s) → `GET /api/ps`; inspector Confirmed, before none / after model; audit created → approve → start → succeed, chain Verified | ✅ |
| Unload: `/api/ps` model → empty; VRAM 3153 → 2268 MiB; **one** `POST /api/generate`; inspector and audit agree | ✅ |
| Agent action (`model.prompt`, approved): run refused (403) | ✅ |
| Process route `start`/`stop`/`restart`/`unload`/`kill`: 403 each | ✅ |
| Strata and PolyStrata as model-control targets: refused (400), no task, no engine request | ✅ (live, see finding 3) |

**Findings from the owner run, fixed in the next commit:**
1. **Task list label.** A succeeded model task showed "Agent-reported complete / Not independently verified". It now shows **"Engine-confirmed"** in the badge, the filter and the legend. The list says "Confirmed against the engine's loaded models", and the provenance Outcome says "Confirmed by the engine… No agent was involved." Agent tasks are unchanged, and "Independently verified" stays untracked.
2. **Outcome message.** The inspector showed "Engine reachable; models listed." for a confirmed load/unload, because the read-only check's messages overrode the model-control ones. Model-control messages now take precedence: the message is "The engine confirmed the operation."
3. **Refusal reason for Strata and PolyStrata.** The live refusal said "The model must be listed by the engine's last successful check". The engine type is now checked first, so the refusal says "Model control is only supported for Ollama".

**Historical outcome wording (follow-up, requested in review):** tasks run before the fix, such as the owner's verified load and unload, recorded "Engine reachable; models listed." in their audit evidence. The inspector now derives the message from the recorded outcome code, using `MODEL_OUTCOME_MESSAGES` in `taskState.js`, which a test keeps equal to the server's `DIAGNOSTICS`. Those tasks therefore read "The engine confirmed the operation." The stored audit entries are never modified, and the original text stays available as `recordedMessage`. Codes that model control doesn't define keep their recorded message.

**Not covered live:** behavior after a real crash or timeout, cancelling during preflight or in flight (covered by automated tests), accessibility, and a browser e2e for the new controls.
