# NyteDesk dashboard UI: review handoff

- **Branch:** `feature/nytedesk-dashboard-ui`
- **Draft PR:** #7, base `feature/nytedesk-stabilization-local-ai` (PR #6)
- **Code verified at:** `0a6a2be16f385638eba8bb2fd00cafa8060a27dd`. The commit that adds this document changes only documentation. The PR body gives the final head.
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
6. **Telemetry.** `GET /api/nytedesk/telemetry` (authenticated, gated, `no-store`) reads only Node's `os` counters: CPU % (needs two samples) and RAM of the NyteDesk server host, with `sampledAt`. The UI shows "Updated Ns ago" and marks samples older than 30s as stale. GPU utilization, VRAM, GPU temperature, tokens/s and context usage show **Unavailable**, with the reason. Nothing is executed (no `nvidia-smi`), and a test enforces that.

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
