# NyteDesk — CI remediation and Local AI Manager integration: review handoff

- **Branch:** `feature/nytedesk-stabilization-local-ai`
- **Draft PR:** #6, base `feature/nytedesk-control-plane-phase1` (PR #1)
- **Code reviewed at:** `f4c452981686087d783e106fcb893e80e0319fd9` (this document and the doc updates come in the next commit; see the PR body for the final head)
- **Branched from:** PR #1 head `b0173cc`
- **Author:** Claude (implementation). **Requested reviewer:** Codex CLI or the owner. Claude has not approved its own work.

Nothing was merged, deployed or enabled. No inference process, VM, host service or unrelated branch was touched.

## 1. What this branch contains

| Source | Head merged | Notes |
|---|---|---|
| PR #5 prompt regression tests | `64f033b` | One remaining failure fixed in `439c1d4`. The test still checks for the source-review safety text; the security instructions are unchanged. |
| PR #4 roadmap | `098f168` | M3 checkboxes updated. |
| PR #3 Local AI Manager foundation | `8ec1f3a` | Extended to three engines, with API and UI (`a9b7b09`). |
| PR #2 chat font slider | `0e7d985` | Fixes for the prompt-size regression, keyboard access and lint (`a9b7b09`). |
| Lint | — | Prettier and unused-binding fixes in base server files (`f4c4529`). |

PR #1 to PR #5 are still open and unchanged. This branch merges them and does not rewrite any of them.

## 2. CI evidence (GitHub Actions at `f4c4529`)

| Workflow | Run ID | Result |
|---|---|---|
| Lint (lint-server, lint-frontend) | 44651050932 | success (collector skipped: no collector changes) |
| Run backend tests (Jest) | 44651050631 | success: 100 suites passed, 1 skipped; **2569 passed, 5 skipped, 0 failed** |
| Fork focused tests (Node 24) | 44651050836 | success |
| Build QA GHCR Image | 44651050678 | skipped by the workflow's own conditions |

PR #1 at `b0173cc`, before this branch, had **lint and backend tests failing**.

## 3. Reproduce locally

```sh
git fetch origin feature/nytedesk-stabilization-local-ai
git checkout f4c452981686087d783e106fcb893e80e0319fd9

# Fork tests (Node ≥ 22.5 for node:sqlite; CI uses 24)
node --test tests/fork/*.test.cjs        # local result: 88 tests, 85 pass, 3 skipped, 0 fail

# Focused suites
node --test tests/fork/nytedesk-engines.test.cjs tests/fork/local-ai-manager.test.cjs \
            tests/fork/chat-font-size.test.cjs tests/fork/nytedesk-api.test.cjs

# Backend (Jest), including the real-session NyteDesk endpoint test
cd server && yarn install && yarn test
yarn test __tests__/endpoints/nytedesk/nytedesk.test.js

# Lint, as CI runs it
cd server && yarn lint:check ; cd ../frontend && yarn lint:check

# Production frontend build: NOT run by Claude (see §5)
cd frontend && yarn install && yarn build
```

The three skipped fork tests need dependencies that are not installed in the sandbox (the same skips as on PR #1).

## 4. Security properties and the tests that check them

| Requirement | Where it is enforced | Test |
|---|---|---|
| No process control: never start, stop, restart, unload or kill; no name matching | `processAction` always returns 403; no `child_process`/`kill` in the module | `nytedesk-engines`: denial for every role × action; source scan with comments stripped |
| Engines are externally owned | `ownership: "external"`, `canStart/canStop: false` | `nytedesk-engines` registry test |
| Invalid endpoints refused | `parseLoopbackEndpoint`: http, 127.0.0.1/[::1], port ≥ 1024, no credentials/query/fragment/`..` | `nytedesk-engines` invalid-endpoint table |
| PolyStrata port is not hardcoded; Strata endpoint is not invented | `defaultEndpoint: null` for both | registry and selection tests (the port is changed during the test) |
| Probe cannot be redirected or flooded | GET only, `agent: false`, no redirect following, timeout, 1 MiB limit | redirect and too-large diagnostics tests |
| Unauthorized config changes refused | admin only for config and selection; manager/admin for checks | `nytedesk-engines` permissions; Jest test: manager PUT → 403 |
| Stale or mismatched check cannot select | 15-minute age, same endpoint, model listed | selection tests (stale, endpoint changed, model missing) |
| Concurrency | CAS on engine `version` and on the selection; idempotency keys | version conflict and idempotent replay tests; the existing two-connection task race test |
| Real authentication | real `validatedRequest` + JWT | Jest: missing/forged/suspended token → 401 |
| No self-approval; workspace isolation | `service.cjs` (PR #1) | Jest: self-approval 403, outsider 404; `nytedesk-api` |
| Stale approvals | 24 h expiry and payload hash checked by `reauthorize` | `nytedesk-api` / `control-plane` (PR #1) |
| Feature gate | `NYTEDESK_ENABLED=true` and multi-user mode | Jest: disabled 403, single-user 403; `nytedesk-engines` gate test |
| Model output is untrusted | Selected engine is recorded as coordinator only; no route lets model output change policy | design; covered by the absence of such routes |
| Secrets never stored | secret-named fields refused for engines and providers | `nytedesk-engines` config test |

The execution preconditions from PR #1 are unchanged: all are still unverified, and `startTask` is not reachable over HTTP.

## 5. Blockers and what is not verified

1. **Frontend production build not run.** The sandbox cannot install npm packages. Evidence instead: CI `lint-frontend` passes, and a TypeScript parser check of the 12 changed frontend files reports no syntax errors. **The owner needs to run `yarn build` in `frontend/`.**
2. **No visual check of the UI.** The font slider (10–22 px, 14 px default/reset, live updates, keyboard access) and the Local AI Engines panel are covered by unit and source tests, but nobody has looked at them in a browser yet.
3. **No server start against real Prisma.** The Jest test uses the real auth middleware but mocked users, workspaces and settings.
4. **No live probe of the owner's engines.** Probes were tested against local stub servers only. Claude did not contact the owner's Ollama or PolyStrata.

## 6. Suggested manual check for the owner (read-only for the engines)

1. Build and start the fork with `NYTEDESK_ENABLED=true` in multi-user mode.
2. As admin, open NyteDesk → Local AI Engines. Configure PolyStrata with the endpoint where it is currently running (for example `http://127.0.0.1:<port>/v1`), model `qwen3.6-35b-a3b-ud-q2_k_xl`, context 32768, VRAM reserve 1024.
3. Press **Check** and confirm the model is listed. Then press **Select**.
4. Confirm that Ollama and PolyStrata keep running, and that their settings and AnythingLLM data are unchanged.
5. In a chat, test the font slider with the mouse and with the keyboard, reload the page, and check that the size is kept.

## 7. Remaining items before engine start/stop support

None of these are implemented. Each needs owner approval and independent review.

1. A separate, authenticated controller running locally (or VM-local), not the web server, holding the only lifecycle rights.
2. Allowlisted executables and fixed argument templates. No user-supplied paths, shell or arguments.
3. Exact process ownership: only processes the controller started (by PID and start time, or a service unit), never by name.
4. Explicit owner confirmation before touching any independently running service, with "leave it alone" as the default.
5. Resource limits and a VRAM/RAM budget for switching engines (RTX 3080 10 GB: the model, the 1024 MiB reserve and the other engine cannot all be loaded at once).
6. Graceful unload, idle behaviour, failure recovery and an emergency stop.
7. Audit entries for every lifecycle action, in the hash-chained log.
8. Tests for denial and for ownership mismatch, and an independent review (Codex CLI) before enabling.
9. A decision on whether lifecycle control runs on the host at all, since the owner's rules keep execution inside the verified VM.

## 8. Not done, by instruction

No merge, deploy, VM reset, host-service change, CLI/VM execution, credential use or paid inference.
