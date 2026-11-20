# NyteDesk PR #6: independent review handoff

- **Branch:** `feature/nytedesk-stabilization-local-ai`
- **Draft PR:** #6, base `feature/nytedesk-control-plane-phase1` (PR #1, `b0173cc`)
- **Code verified at:** `83e73bff230f6d866832bff98388345c87aace34`. The commit that adds this document changes only documentation. The PR body gives the final head.
- **Author:** Claude (implementation). **Requested reviewer:** Codex CLI or the owner. The author has not approved his own work.

Nothing was merged or deployed. No process control, CLI or VM execution, or AgentBridge dispatch was enabled. Claude did not contact or change the owner's Ollama, PolyStrata, Strata, VM or host.

## 1. Verification levels

| Level | What it covers | Status |
|---|---|---|
| **Automated, CI** | Lint, Jest backend, fork tests, **production `vite build`** | All pass at `83e73bf` (§3) |
| **Simulated integration** | Real NyteDesk routes, service, SQLite and probe over HTTP, against **mock engines** on loopback | Pass (fork tests) |
| **Real browser, harness** | Real headless Chrome running the real `textSize.js` and the real `index.css` chat rules. **Not the AnythingLLM app.** | Pass, in CI and in Claude's sandbox |
| **Real browser, full app** | AnythingLLM UI, NyteDesk panel, slider in the running app | **Not done** (§5) |
| **Real hardware or services** | Owner's CachyOS, RTX 3080, live Ollama and PolyStrata | **Not done** (§5) |

## 2. Commits since the previous review (`55518c1`)

| Commit | Change |
|---|---|
| `cd4e06d` | Slider and Local AI Manager defect fixes, with tests (§4) |
| `921862a` | CI: production frontend build job and real-Chrome harness job. The fork workflow now also runs on NyteDesk server and frontend changes. Owner-authorized: read-only token, no secrets, nothing published |
| `83e73bf` | Lint: model names are filtered by character code instead of a control-character regex |

## 3. CI evidence at `83e73bf`

| Workflow, job | Run | Result |
|---|---|---|
| Lint: lint-server, lint-frontend | 44656887300 | success (collector skipped: unchanged) |
| Run backend tests (Jest) | 44656887375 | success: 100 suites, 1 skipped; **2569 passed, 5 skipped, 0 failed** |
| Fork focused tests: focused-tests | 44656887257 | success: **100 tests, 100 pass, 0 skipped** |
| Fork focused tests: **frontend-build** | 44656887257 (job 136025190002) | success: `vite v4.5.3`, 6211 modules, built in 24 s, `dist/_index.html` present. Only the existing upstream chunk-size and peer-dependency warnings |
| Fork focused tests: browser-harness | 44656887257 (job 136025190386) | success: 5/5 in Chrome |
| Build QA GHCR Image | 44656887250 | skipped by its own conditions (it publishes images, so it was not used) |

At `55518c1`, `lint-server` had passed, but the frontend build had never run anywhere.

## 4. Defects found and fixed

**Text-size slider**

1. **Wrong legacy migration.** A saved "small" mapped to 11px. AnythingLLM's "small" was `text-[12px]`, so it now maps to 12px. Legacy and out-of-range stored values are rewritten once.
2. **No cross-tab sync.** Other open tabs kept the old size. One `subscribeChatFontSize` helper (local event plus `storage` event) now drives the hook and every control.
3. **Touch screens.** A tap fired mouse-enter (open) and then click (toggle shut), so the submenu closed at once. Hover now opens only for a mouse pointer, and the click after a hover keeps the menu open.
4. **Phones.** The submenu flew out to the left by about 190px, past the screen edge on a 375px-wide phone. Below the `md` breakpoint it now opens inline under the row.
5. **Markdown at large sizes.** Headings, tables and code had fixed sizes, so at 22px an h3 (18px) was smaller than body text. Inside the chat history only (`.chat-font-scale`), they now scale in `em`. At the 14px default the sizes are exactly the old 32, 24, 18, 13 and 14px; this is checked in Chrome. Other markdown surfaces are unchanged.

**Local AI Manager**

6. **Selection rule.** The listing and the route used different checks: the UI showed **Select** for any reachable engine, even with a stale check, a changed endpoint or a missing model. One `selectionBlocker` rule now feeds both, and the listing returns `selectable`, `selectionBlockedReason` and `selected`.
7. **Bad timestamp passed the freshness test.** A check record with an invalid `checkedAt` produced `NaN > limit` (false) and was accepted. It is now refused.
8. **Idempotency-key reuse.** The UI kept one key per card, so selecting A, then B, then A again was refused as "key already used for a different request". Keys now rotate after every answered request and are reused only after a network failure.
9. **Save button.** `CTAButton` calls `onClick()` without the event, so `save` threw on `e.preventDefault()` and only the browser's implicit submit saved. Save is now a real submit button with a busy state.
10. **Unfiltered model names.** Names from an engine were stored and shown without limits. They are now printable, at most 256 characters each, de-duplicated, and at most 200 names.
11. **Unclear UI.** The panel now shows:
    - state labels: reachable, unreachable, not checked, not configured ("stopped" was misleading, since NyteDesk cannot know process state);
    - a note on what the current role may do;
    - why Select is unavailable;
    - a warning when the selected engine is unreachable or was reconfigured;
    - which endpoint a check covered, the HTTP status, and whether the model is listed;
    - labels on every field.

    There are still no start, stop, restart, unload or kill controls.

## 5. Not verified (blockers for full acceptance)

1. **The full app in a real browser.** Nobody has looked at the NyteDesk page or the chat slider in the running app (desktop and mobile widths, light and dark themes). Claude could not reach the Unraid VM: its console page uses a self-signed certificate, and the desktop's sandboxed shell would not start.
2. **Server start against real Prisma.** The Jest test uses the real `validatedRequest` and JWTs, but mocked users, workspaces and settings.
3. **Live engines.** Probes were tested only against mocks. The workflow test binds its mock PolyStrata to port 40537 when that port is free, but no real engine has been contacted.
4. **Upstream dead code.** `ChatContainer/TextSizeMenu` and `PromptInput/TextSizeMenu` are imported nowhere, here or upstream. They are kept in sync but never rendered; the live control is the chat settings menu row.

## 6. Reproduce

```sh
git checkout 83e73bff230f6d866832bff98388345c87aace34
node --test tests/fork/*.test.cjs                                   # 100 tests
node --test tests/fork/nytedesk-engine-workflow.test.cjs            # owner workflow, mock engines
cd frontend && yarn install --frozen-lockfile && yarn build && cd ..
cd server && yarn install && yarn test && yarn lint:check && cd ..
cd frontend && yarn lint:check && cd ..
# Real-Chrome harness (needs playwright or playwright-core, and Chrome)
NODE_PATH=<dir>/node_modules CHROME=$(which google-chrome) node tests/browser/chat-font-size.browser.cjs
```

## 7. Owner checklist (in the dedicated VM, read-only toward the engines)

1. Build and start the fork with `NYTEDESK_ENABLED=true` in multi-user mode, and sign in as an admin.
2. Go to Settings → NyteDesk → Local AI Engines. Configure PolyStrata with the endpoint where it currently runs (for example `http://127.0.0.1:40537/v1`), model `qwen3.6-35b-a3b-ud-q2_k_xl`, context 32768 and VRAM reserve 1024. Then press **Check**, confirm the model shows as listed, and press **Select**.
3. Change only the port to a wrong one and save. Selection should be blocked, and the selected-engine warning should appear. Restore the port.
4. As a manager: Check works, and Configure and Select are not shown. As a default user: the panel is read-only.
5. Chat slider: move it with the mouse and with the arrow keys, Home and End; press Escape; reload. Open two tabs and change the size in one. Try a phone-width window and a touch device. Check a reply that has headings, a table and a code block at 10px and at 22px.
6. Confirm Ollama, PolyStrata and AnythingLLM data are unchanged and still running.

## 8. Readiness assessment

- **Ready for independent code review:** yes. All CI checks pass at `83e73bf`, the production build compiles, and the slider and engine workflows have simulated and harness coverage.
- **Not ready for acceptance or merge** until the full-app browser check (§5.1) and the owner checklist (§7) are done. Process control remains disabled by design.

## 9. Recommended next milestone

**M3b: owner-verified Local AI Manager.**

1. Run the §7 checklist in the VM.
2. Optionally add a Playwright smoke test of the built app (seeded admin, mock engines) to CI.
3. Remove or wire up the two unused text-size menus.

Only after that, design **engine lifecycle control** under a separate review. It would need:

- a separate authenticated controller;
- allowlisted executables and arguments;
- exact process ownership (never by name);
- owner confirmation for externally owned services;
- an RTX 3080 10 GB VRAM budget;
- hash-chained audit;
- denial tests and a Codex review;
- an owner decision on whether any of it runs outside the VM.
