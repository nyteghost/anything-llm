# NyteDesk dashboard UI: review handoff

- **Branch:** `feature/nytedesk-dashboard-ui`
- **Draft PR:** #7, base `feature/nytedesk-stabilization-local-ai` (PR #6)
- **Code verified at:** `1d2706897de03966dc52519363036330d86507bc`, after the re-review corrections (§10). Earlier rounds were verified at `dfe63bc` (§9) and `0a6a2be`. The commit that updates this document changes only documentation. The PR body gives the final head.
- **Design reference:** the owner-approved Gemini dashboard concept.
- **Author:** Claude. **Requested reviewer:** Codex CLI or the owner. The author has not approved his own work.

Nothing was merged or deployed. No CLI, VM or AgentBridge execution was enabled. The owner's services were not contacted.

## 1. What was built

A new `/nytedesk` area. AnythingLLM's own pages are unchanged, and `/settings/nytedesk` links to it.

| Concept element | Implementation |
|---|---|
| Left navigation with badge, status box, user | `Shell.jsx`. Collapsible, and the setting persists. Below `md` it becomes a drawer (`aria-modal`, Escape closes). Status shows the selected engine, execution (Disabled) and engine reachability. |
| Search / command bar | Jumps to sections and workspaces; Ctrl/⌘+K focuses it. ARIA combobox. |
| KPI row | Active engine, Model, Open tasks, Pending approvals, Agents, System health. All values come from the API. |
| Chat workspace | AnythingLLM's own `WorkspaceChat` component, unchanged, with a workspace selector. Uploads, threads, agents and text size are kept. |
| Right sidebar | Agents and roles, System metrics, Recent activity, Pending decisions. |
| Main/sidebar split | Drag, arrow keys, Home/End, double-click to reset. Width persists (260–520px, and the chat keeps at least 420px). Stacks below `lg`. |

Sections: Dashboard, AI Workspace, Local AI Manager (the PR #6 panel), AgentBridge, Tasks & Projects, Approvals, Knowledge Base, Memories, Logs & Diagnostics, and Settings (links to the existing page). `/nytedesk/approvals/:taskId` and `/nytedesk/tasks/:taskId` open the inspector.

## 2. The six required refinements

1. **Resizable layout.** Collapsible navigation, a resizable chat/sidebar split, persisted widths, minimum widths, and drawer and stacked layouts on smaller screens.
2. **Agent identity.** A server catalog, `COMPONENTS` in `control-plane.cjs`, served with `/nytedesk/agents`, lists:
   - the local coordinator model (agent);
   - PolyStrata, Strata and Ollama (**inference engines, not agents**);
   - Claude Code CLI (implementer);
   - Codex CLI (coding and independent review);
   - AgentBridge (orchestration and policy).

   Nothing in it may approve. Task adapters named after an engine are shown as "Local coordinator via <engine>".
3. **Approval inspector.** Shows:
   - the exact operation (verbatim description, action, target, workspace, version);
   - requester and provenance;
   - affected resources and files;
   - risk and permissions (from the server's `protected` flag);
   - evidence (payload hash, audit-chain verification);
   - the full audit history;
   - Approve and Reject.

   Approve stays disabled until the person confirms the review. Decisions go through the existing API with the reviewed version and payload hash, and the server decides. Self-approval, role limits and protected actions are explained before anyone tries.
4. **Text size.** The top bar reuses the existing shared popover; there is no second implementation. It was extended to be positionable, close on Escape, and announce `aria-valuetext`. Markdown and code scaling come from PR #6.
5. **Execution status.** Labels map 1:1 from the backend state machine:
   - queued → Queued
   - waiting_approval → Awaiting approval
   - approved → Approved
   - running → Executing
   - succeeded → **Agent-reported complete**
   - failed → Failed
   - denied → Rejected
   - cancelled → Cancelled

   "Proposed" and "Independently verified" appear in the legend as **not tracked yet** and are never shown for a task. Provenance gives requester, approver and last event.
6. **Telemetry.** `GET /api/nytedesk/telemetry` (authenticated, gated, `no-store`, **managers and administrators only**, see §9 F5) reads only Node's `os` counters: CPU % (needs two samples) and RAM of the NyteDesk server host, with `sampledAt`. The UI shows "Updated Ns ago" and marks samples older than 30s as stale. GPU utilization, VRAM, GPU temperature, tokens/s and context usage show **Unavailable**, with the reason. Nothing is executed (no `nvidia-smi`), and a test enforces that.

## 3. Verification (CI at `0a6a2be`)

| Check | Kind | Result |
|---|---|---|
| Lint, server and frontend (run 44844981665) | automated | ✅ |
| Backend Jest (run 44844981616) | automated, real `validatedRequest` and JWT | ✅ 2570 passed, 5 skipped, 0 failed (includes the new telemetry and roles test) |
| Fork tests (run 44844981618, `focused-tests`) | automated | ✅ 120/120 |
| Production `vite build` (`frontend-build`) | automated | ✅ 6222 modules |
| **Real app in Chrome** (`dashboard-e2e`) | **actual running implementation**: production server, production build, fresh SQLite, real login, seeded users/workspace/tasks, **mock engines** | ✅ 18/18 checks |
| Slider harness (`browser-harness`) | real Chrome, module-level harness | ✅ |

Checks covered by `dashboard-e2e` (`tests/e2e/nytedesk-dashboard.e2e.cjs`):
- **Dashboard data:** engine, model and approval counts come from the API; metrics are real, or "Unavailable"; there are no process-control buttons.
- **Layout:** the account button sits inside the top bar without covering anything (bounding boxes compared); engine card buttons don't overlap; on mobile there is no horizontal overflow and the drawer closes with Escape.
- **Chat:** the embedded chat renders, and the original `/workspace/:slug` page still works.
- **Persistence and keyboard:** keyboard resize persists across reload, nav collapse persists, and text size reaches 22px from the keyboard, persists and closes on Escape.
- **Approvals:** the inspector shows all six sections; Approve stays disabled until the review is confirmed; approving records `approved` on the server; the requester and a default user are blocked, with the reason shown.
- **Errors:** no uncaught page errors.

Screenshots of the running implementation (17) are uploaded as the `nytedesk-dashboard-screenshots` workflow artifact. They are also printed into the job log. **They show the real app with seeded test data, not the design concept.**

**Not verified:**
- the owner's hardware or engines (GPU telemetry is unavailable by design);
- a screen reader;
- an automated contrast or axe scan (axe-core is not available offline here);
- Safari and Firefox, since only Chrome was tested.

## 4. Defects found and fixed while verifying

1. **Wrong page title.** The dashboard said "Dashboard" instead of "Main dashboard": the object spread order overwrote it.
2. **Account button overlap.** AnythingLLM's account button overlapped the top bar on every viewport and hid the text-size control on tablet and mobile. A scoped `:has()` rule now places it inside the top bar, which reserves room for it.
3. **PR #6 Local AI Manager buttons overlapped.** `CTAButton`'s corner `-mr-8` margin caused it.
4. **Chat too short at 1024×768.** The panel now has a minimum height and the page scrolls.
5. **Backend Jest never ran for NyteDesk server code.** It is `.cjs` and the workflow matched only `server/**.js`. The trigger now includes `server/**.cjs`.

## 5. Accessibility review

**In place:**
- landmarks (`nav`, `banner`, `main`, labelled regions);
- `aria-current` on navigation;
- labelled collapsed icons;
- the separator has value, min and max and works from the keyboard;
- ARIA combobox and listbox in the command bar;
- `meter` roles for measured values;
- the drawer is a modal dialog with Escape;
- the text-size dialog has Escape and focus return;
- explicit text for every state (no colour-only meaning);
- approval needs an explicit checkbox;
- decision blockers use `role="status"`.

**Open:**
- the mobile drawer does not trap focus;
- no axe or contrast scan has been run;
- the command bar closes on blur with a short timeout;
- the reused "Propose a task" form from PR #1 keeps its older styling;
- the account-button rule needs `:has()` (Chrome 105+, Safari 15.4+, Firefox 121+).

## 6. Security review

- **Permissions:** no new execution, dispatch, process-control or shell path. The UI never calls `/process` or `start` (source test plus e2e). Every decision goes through the existing role, protected-action, self-approval, version and payload-hash checks.
- **Telemetry:** `node:os` only (source test: no `child_process`, `exec`, `fetch` or `nvidia`), authenticated and feature-gated, `Cache-Control: no-store`. **Finding:** it shows host CPU count and memory to any authenticated NyteDesk user. Restrict it to managers and admins if that matters.
- **Untrusted content:** model names, task text and diagnostics render as React text; no new `dangerouslySetInnerHTML`.
- **Embedded chat:** uses AnythingLLM's own workspace authorization (`Workspace.bySlug`).
- **Command bar:** navigates only to internal routes.
- **CI:** read-only token, `persist-credentials: false`. Per-run random test passwords and secrets; no repository secrets. Mock engines on loopback. Screenshots contain only seeded data. `playwright-core@1` is installed unpinned (pin it if reproducibility matters).

## 7. Deviations from the concept, on purpose

- Placeholder agents (Agent-Alpha…) are replaced by the real roles.
- The concept's progress bars and percentages for tasks are omitted, because no progress data exists.
- "GPU Health" shows CPU and "GPU unavailable", because no GPU source exists.
- The "FP16" chip is replaced by the configured context size, because the quantization is not reported.
- The inline **Approve** in "Pending decisions" became **Inspect and decide**, so nothing is approved without the inspector.
- The browser window chrome from the image is not reproduced.

## 8. Remaining work

1. A safe GPU, VRAM and throughput source: a read-only exporter or engine-reported metrics, never a shell. The owner decides.
2. Task schema additions for proposals, declared files, evidence and independent verification records, so those states and fields can be shown.
3. A focus trap in the mobile drawer; an axe and contrast scan; Safari and Firefox passes.
4. Restyle the reused "Propose a task" form.
5. Owner check in the dedicated VM, and Codex review.

## 9. Independent review corrections (review comment 7054452838)

Verdict received: changes requested; 5 should-fix and 1 nit; no authorization or execution bypass found. All are addressed in `dfe63bc`.

| Finding | Correction | Regression tests |
|---|---|---|
| **F1** Review confirmation not tied to the inspected task | The confirmation is bound to the exact task `id`, `version` and `payloadHash` (`reviewBinding` and `reviewMatches`), so any other revision voids it. A task change clears the shown detail, reason, keys and confirmation. Loads are sequenced (`createSequencer`), so a late response for an earlier task is dropped, and a response whose task id differs is ignored. Approve re-checks the binding before sending. The task reloads when the window regains focus, so a server-side change voids the confirmation. The server still decides. | Unit: binding, out-of-order loads. Source: reset effect and guards. **e2e:** A→B client-side navigation leaves B unconfirmed with Approve disabled; a 2 s delayed response for A does not replace B. |
| **F2** Dashboard data can stay stale | Tasks, approvals and engines refresh every 30 s while the tab is visible, and on window focus or visibility (at most once per 5 s). Runs are single-flight. A failed refresh keeps the last good data. The top bar shows loading, refreshing, fresh, stale (over 90 s) and failed states with the last success time (`role="status"`), plus a manual refresh. The telemetry lifecycle is unchanged. | Unit: single-flight, freshness states. Source: intervals, focus, cleanup. **e2e:** a task created by another user appears after focus; a simulated 500 shows "failed", keeps the data, and recovers to "fresh". |
| **F3** Mobile drawer focus | Opening moves focus into the drawer, and Tab/Shift+Tab cycle inside it. The page content and AnythingLLM's account button are `inert` and `aria-hidden` while it is open. Escape and the backdrop close it, focus returns to the opener, and the drawer closes when the viewport grows to desktop. | Source checks. **e2e at 390×844:** 16 Tab and 16 Shift+Tab presses stay inside; background and account button are inert; Escape restores focus to "Open navigation" and removes inert; backdrop click closes. |
| **F4** CI reproducibility and log exposure | `playwright-core` is pinned to **1.63.0** in `tests/e2e/package.json` plus a lockfile with a sha512 integrity hash, installed with `npm ci --ignore-scripts` (both browser jobs). Base64 screenshot output was removed from the logs. Screenshots are kept only as the workflow artifact (7 days, seeded test data only). | Source check on the workflow and lockfile. CI shows `added 1 package` from the lockfile in both jobs. |
| **F5** Telemetry visible to all users | Manager/admin-only, enforced in `service.telemetry()` (403, nothing returned). The UI does not request it for other roles and shows "Restricted". The policy is documented in `NYTEDESK_CONTROL_PLANE.md` for the owner to confirm. | Fork: 401 without a token, 403 for a default user, 200 for manager and admin, gates still apply. Jest (real JWT): 403 for default, 200 for manager and admin. **e2e:** the default user sees "Restricted", and a direct API call gets 403. |
| **Nit** Structure-dependent `:has()` selector | AnythingLLM's `UserButton` has a `data-user-menu` attribute, and the dashboard sets `body.nytedesk-route` only while mounted. The CSS is `.nytedesk-route [data-user-menu]`, with no `:has()` and no dependence on DOM position. | Source check. **e2e:** bounding boxes on desktop (1440×900) and mobile (390×844) show the account button clear of the text-size control and inside the top bar. |

### Verification at `dfe63bc` (CI)

| Check | Run | Result |
|---|---|---|
| Lint, server and frontend | 44846936271 | ✅ |
| Backend Jest | 44846936238 | ✅ 2570 passed, 5 skipped, 0 failed |
| Fork tests (`focused-tests`) | 44846936287 | ✅ 129/129 |
| Production `vite build` (`frontend-build`) | 44846936287 | ✅ 6222 modules |
| Browser harness | 44846936287 | ✅ 5/5 (pinned driver) |
| **Real app in Chrome** (`dashboard-e2e`) | 44846936287 | ✅ 24/24; screenshots artifact 14682819902 (expires 2026-11-28) |

### Limits

- Claude could not open the new screenshot artifact: this sandbox's network blocks GitHub's artifact storage, and screenshots are no longer printed into logs, by design. The corrected behaviour is verified by e2e assertions, not by Claude viewing images.
- `tabindex` and `inert` handling assumes a browser with `inert` support (Chrome 102+, Safari 15.5+, Firefox 112+).
- Still not done: the owner's hardware or engines, a screen reader, an axe or contrast scan, Safari and Firefox.

## 10. Re-review corrections N1–N3 (re-review of `dfe63bc`)

The re-review decision was **changes requested**. F1, F4, F5 and the CSS item were resolved; F2 and F3 needed edge-case fixes. No authorization or execution issue was found. All three are addressed in `1d27068`.

| Finding | Correction | Tests |
|---|---|---|
| **N1** Freshness hidden below `lg` | The indicator is always visible: a coloured dot (fresh green, refreshing blue, loading grey, stale amber, failed red) with a short label below `lg` ("10s ago", "Refreshing", "Stale 3m ago", "Failed") and the full sentence from `lg`. A polite `sr-only` live region announces the full sentence ("Dashboard data: …"). Manual refresh is kept. The top bar gap is tightened and the title truncates, so nothing overlaps. Times come only from `lastSuccessAt`. | Unit: short labels for every state; stale and failed always differ. Source: no `hidden lg:inline`, both labels, dot map. **e2e:** at 390, 768, 1024 and 1440, the indicator, refresh button, text-size control and account button are visible and have no overlapping bounding boxes, and the full label shows only from 1024. On a phone, Failed (red) and Stale (amber) are both shown and differ in text and dot class. |
| **N2** Focus lost on mobile → desktop | Reaching the desktop breakpoint closes the drawer, and cleanup clears `inert` and `aria-hidden`. On the next animation frame, only if focus would otherwise be lost, focus goes to the opener if it is still visible, else to the desktop nav's `aria-current="page"` link, else to the nav's first focusable control (`restoreFocus`). The opener reference is cleared, so no detached node is kept. The desktop nav is never in the inert set. | Source checks. **e2e:** open the drawer at 390 with the keyboard, Tab inside, resize to 1440: the drawer closes, nothing is inert or aria-hidden, focus is on the visible "Dashboard" link (`aria-current="page"`) in the desktop nav, and Tab keeps focus. Resize back to 390: the drawer reopens, Shift+Tab stays inside, Escape returns focus to "Open navigation", and a backdrop click closes it. The existing F3 test still passes. |
| **N3** In-flight requests after unmount | Data and telemetry requests each take a token from a per-mount sequencer and are checked after every `await`, before any state update; only the newest token applies. Unmount cancels both sequencers and drops the shared in-flight refresh. The lifecycle effect runs before the fetching effects and is StrictMode-safe (fresh sequencers on every mount). Single-flight, the 30 s interval, the 5 s focus throttle, last-good data, the manager/admin telemetry gate and the hidden-tab rules are unchanged. | Unit: `cancel()` voids current and future tokens; a late response after unmount applies nothing. Source: two guards in `load`, one in telemetry, cancel on unmount, unchanged constants. **e2e:** a manual refresh plus 5 focus events during a 2 s request make exactly 1 request. Unmounting during a delayed refresh gives 0 data and 0 telemetry requests over 11 s, no page errors, the body class removed, and a clean remount. A hidden tab with 2-minute-old data shows Stale with 0 data and 0 telemetry requests over 31 s, then refreshes when visible again. |

### Verification at `1d27068` (CI)

| Check | Run | Result |
|---|---|---|
| Lint, server and frontend | 44848801073 | ✅ |
| Backend Jest | 44848801036 | ✅ 2570 passed, 5 skipped, 0 failed |
| Fork tests (`focused-tests`) | 44848801065 | ✅ 135/135 |
| Production `vite build` | 44848801065 | ✅ 6222 modules |
| Browser harness (pinned driver) | 44848801065 | ✅ 5/5 |
| **Real app in Chrome** (`dashboard-e2e`) | 44848801065 | ✅ 32/32, no base64 in the log |

Screenshots artifact `14684752143` (expires 2026-11-28) holds seeded data only. It includes desktop, the 1024×768 and 768×1024 tablets, the 390×844 phone, the mobile drawer, and the new `18-mobile-freshness-failed` and `19-mobile-freshness-stale`.

### Limits
- The e2e simulates a hidden tab and aged data by overriding `document.hidden` and `Date.now` in the page; it does not actually background a browser tab.
- Claude could not open the screenshot artifact from his sandbox; the behaviour is evidenced by the assertions.
- Still not done: the owner's hardware or engines, a screen reader, an axe or contrast scan, Safari and Firefox.

## 11. Owner verification (owner run, 2026-11-21)

**The owner declared PR #7 "owner verified"** on 2026-11-21 after running `NYTEDESK_OWNER_VERIFICATION.md` on the dedicated VM `agentbridge-vm`. Every command was run by the owner; Claude only read the pasted output and screenshots. The code under test is the accepted `1d27068`; the branch tip `777e6d1` adds documents only (the owner confirmed that the diff against `1d27068` contains only `.md` files).

### Setup
- VM: Arch on Unraid `tower`, at 10.200.1.124. The checkout's own Node 24.22.3 and Yarn 1.22.22; system Node 26.13.1 is used only for `--check`.
- Engines stay on the owner's desktop and are reached through SSH reverse tunnels started from the desktop:
  - VM port 41434 → desktop Ollama on 11434;
  - VM port 41600 → desktop Strata on 40538.
  - PolyStrata was not running.
  - VM port 11434 was deliberately left unconnected, so AnythingLLM's own chat cannot reach the GPU.
- Browser access went through `ssh -L 127.0.0.1:13002:127.0.0.1:3002`.
- Launched with `export NYTEDESK_ENABLED=true; tools/linux-run.sh`.

### Results
| Area | Evidence | Result |
|---|---|---|
| Repo and tests | HEAD `777e6d1`; Stage 2 offline tests | ✅ 135/135, 0 skipped |
| GPU baseline (desktop) | `nvidia-smi`, `/api/ps` | 9229 MiB, 3%; `{"models":[]}` (Strata had a model loaded on its own) |
| Ollama Check | card: `reachable`, HTTP 200 in 22 ms, models listed | ✅ |
| Strata Check | card: `check failed`, HTTP 401 in 2 ms, `HTTP_ERROR`; no Select button | ✅ failure path |
| Missing API style | `API_UNKNOWN`, refused before Strata was contacted | ✅ fail-safe |
| Select | "Coordinator engine: ollama at http://127.0.0.1:41434"; model none | ✅ records the choice only |
| No model load | `/api/ps` empty after Check, after Select and at the end; VRAM 9091, 9095 and 9167 MiB (0–3%) | ✅ |
| Default user | System health "Restricted"; no metrics; engines page read-only; no decision buttons | ✅ |
| Manager | metrics shown (CPU 0.3% of 4 cores, RAM 1.0/7.7 GB, GPU unavailable); Check only | ✅ |
| Admin | Configure and Select available | ✅ |
| Approval integrity | task proposed by user #3 (default): exact operation, provenance, payload hash, "bound to this payload hash, expires after 24 hours", execution disabled; requester sees "Someone else must approve or reject it"; rejected by user #2 (manager); audit history `task.created` then `task.deny`, chain Verified; version 2 → 3; "not awaiting approval" afterwards | ✅ |
| Listeners (VM) | NyteDesk only on loopback | ✅ (OS services: resolved on 127.0.0.53/54, LLMNR on 0.0.0.0:5355; not NyteDesk) |
| Processes (VM) | launcher → 2 × `node index.js`; no shell, `nvidia-smi` or engine children; `pgrep` matched only `avahi-daemon` by hostname | ✅ |
| Engines after the run | Strata still HTTP 401; Ollama `{"models":[]}` | ✅ untouched |

### Findings for follow-up (not blockers)
1. **Engine credentials.** Strata requires an API key, and NyteDesk refuses secret fields by design. Strata model listing and selection cannot be verified. A design decision is needed.
2. **Misleading label.** The dashboard's Agents panel shows Strata as "Unreachable", but it answered HTTP 401. The Local AI Manager card says "check failed", correctly. Suggested fix: "Check failed" or "Auth required".
3. **Embedded chat navigation.** Sending from the playground's start composer opens the full chat thread and leaves `/nytedesk` (upstream thread creation).
4. **Coordinator label.** The playground header says "Coordinator: Ollama" (NyteDesk's selection at 41434), but the chat uses AnythingLLM's own LLM setting (11434). The label can mislead.
5. **Slow install step.** The puppeteer install step was slow on its second browser download. It finished without needing the `PUPPETEER_SKIP_DOWNLOAD` fallback.

### Owner environment notes (no changes made)
- The desktop Ollama listens on all interfaces.
- The VM runs LLMNR on 0.0.0.0:5355.
- A reverse tunnel fails with "remote port forwarding failed" while an earlier tunnel still holds the port. Close it, then retry.

### Not covered
- PolyStrata (not running).
- Strata model listing (needs credentials).
- The shutdown port-release output was not pasted; the engines were confirmed untouched afterwards.
- A screen reader, axe or contrast scan, Safari and Firefox.
- K1 and K2 (PR #8) still need independent re-review.

### Unchanged rules
- No merge, deploy, dispatch or credential use happened.
- PR #6 and PR #7 stay unmerged until the owner decides.
