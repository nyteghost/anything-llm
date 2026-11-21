# NyteDesk PR #7: owner verification guide

This is a controlled verification of the dashboard, engines, permissions, approvals and telemetry on the owner's dedicated development VM. **It does not authorize production deployment or integration.** Nothing here merges, deploys, enables execution, dispatches agents, or changes any inference engine.

## 0. What is being verified

| Item | Value (checked against GitHub when this guide was written) |
|---|---|
| PR #7 | Draft, unmerged; head: see the PR body (documentation-only commits after the accepted code) |
| Accepted code | `1d2706897de03966dc52519363036330d86507bc`. The head differs only in `NYTEDESK_DASHBOARD_HANDOFF.md` (plus this guide once committed). |
| PR #6 (base) | Draft, unmerged; head `70742d59e17fc07b34adfb3914ce14725fba546f` |
| Independent QA | Approved for owner verification (relayed by the owner). Two non-blocking nits: live-region verbosity, and extra test coverage. |

Status labels used below:
- **CI verified:** GitHub Actions at `1d27068`.
- **Locally verified:** the owner ran a command on the VM.
- **Owner verified:** the owner checked it by hand.
- **Not verified.**

Nothing is "owner verified" until the owner records the evidence (§8).

## 1. Decisions and prerequisites (owner action)

1. **Where the instance runs. Recommended: the dedicated VM.** The engines run on the desktop (CachyOS, RTX 3080) and listen on loopback. NyteDesk only accepts loopback engine endpoints, by design. So the VM reaches them through **SSH reverse tunnels started from the desktop** (§4). Nothing on the engines is changed, and the tunnels stop when you close them.
   - Running the instance on the desktop instead would need no tunnels. But the repository launcher uses ports 3002/8889 (it refuses to start if they are busy, so it won't take over another instance), and its default `.env` points AnythingLLM's own chat at the desktop's real Ollama. Only choose this if you accept that.
2. **VM requirements.**
   - Linux x86-64 with `bash`, `git`, `curl`, `node` and `npm` (any version: the launcher installs a checkout-local Node 24.22.3 and Yarn 1.22.22 when needed), plus `flock` (util-linux), `make` and `g++`.
   - A browser in the VM, **or** SSH from the desktop to the VM to forward the web page (§5).
   - About 3 GB of free disk space.
3. **SSH from the desktop to the VM** (`ssh <vm-user>@<vm-host>` works from the desktop). Use your existing key; don't share it.
4. **Engine facts only you know:**
   - PolyStrata's **current** port (it changes between sessions; it was 40537 when last observed);
   - Strata's address and whether it speaks the Ollama or the OpenAI API;
   - that Ollama is on `127.0.0.1:11434` on the desktop.
5. **Three test accounts:** admin, manager and default user. Choose the passwords yourself and keep them private; nobody else needs them.
6. **Ports free in the VM:** 3002 and 8889 (the launcher), and 41434, 41537 and 41600 (the tunnel endpoints). The launcher checks 3002 and 8889 itself.
7. **Agree the no-inference rule for this session:** no chat messages and no document uploads in the test instance, unless you decide otherwise (see §6.3). Engine checks only list models and never load one.

## 2. Stage 1: isolated checkout (VM)

Run these in a VM terminal. If your shell is fish, type `bash` first.

```bash
mkdir -p ~/nytedesk-verify && cd ~/nytedesk-verify
git clone --branch feature/nytedesk-dashboard-ui https://github.com/nyteghost/anything-llm.git
cd anything-llm
git rev-parse HEAD
git diff --stat 1d2706897de03966dc52519363036330d86507bc HEAD
test ! -e server/.env && echo "OK: no server/.env yet"
tools/linux-run.sh --check
```

Expected:
- `git rev-parse HEAD` prints the PR #7 head shown in the PR body. Record it.
- The diff lists only `.md` files, which proves the code is the QA-accepted `1d27068`.
- You see `OK: no server/.env yet`.
- `--check` prints the paths of `node`, `npm` and `flock`, a Node version, and "This launcher uses Node 24, Yarn Classic, ports 3002/8889, and this checkout's server/storage."

**Stop if** the SHA differs from the PR body, the diff lists non-`.md` files, or `flock` is missing.

Everything this instance creates stays inside `~/nytedesk-verify/anything-llm`:
- `server/storage` (databases and logs, including `nytedesk/nytedesk.db`);
- `server/.env` (random secrets, mode 600);
- the checkout-local toolchain in `server/storage/.fork-toolchain`;
- `collector/.env`.

It does not read or write your existing AnythingLLM installation, and it binds only to `127.0.0.1`.

## 3. Stage 2: optional automated checks (VM)

These repeat the CI fork suite on your machine. They use mocks only and contact no engine.

```bash
cd ~/nytedesk-verify/anything-llm
tools/linux-run.sh --check-toolchain
```

That prints `v24.x` and `1.22.x`. The first run may install the local toolchain (one time, inside the checkout).

```bash
TOOLCHAIN="$PWD/server/storage/.fork-toolchain/node_modules/node-linux-x64/bin"
[ -x "$TOOLCHAIN/node" ] && export PATH="$TOOLCHAIN:$PATH"
node --version
node --test tests/fork/*.test.cjs 2>&1 | tail -n 8
```

Expected: `ℹ tests 135`, `ℹ fail 0`. Up to 3 tests may be skipped if server dependencies aren't installed yet; run it again after Stage 4 for 135/135. CI got 135/135.

## 4. Stage 3: read-only engine checks and tunnels (desktop, then VM)

### 4.1 Baseline on the desktop (read-only)

These commands only read. Run them in a desktop terminal (fish is fine) and keep the output for the evidence.

```fish
curl -sS -m 5 -o /dev/null -w 'ollama /api/tags HTTP %{http_code}\n' http://127.0.0.1:11434/api/tags
curl -sS -m 5 http://127.0.0.1:11434/api/ps
curl -sS -m 5 -o /dev/null -w 'polystrata /v1/models HTTP %{http_code}\n' http://127.0.0.1:<POLYSTRATA_PORT>/v1/models
nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv
```

For Strata, use the check that matches its API:
- **OpenAI-style:** `curl -sS -m 5 -o /dev/null -w 'strata HTTP %{http_code}\n' <STRATA_URL>/models`
- **Ollama-style:** `curl -sS -m 5 -o /dev/null -w 'strata HTTP %{http_code}\n' <STRATA_URL>/api/tags`

`/api/ps` lists the models Ollama currently has loaded. `nvidia-smi` is run **by you**, read-only, to record VRAM before the session. NyteDesk itself never runs it.

### 4.2 Reverse tunnels (desktop)

Each tunnel makes one desktop engine reachable **only on the VM's loopback**. Replace the placeholders, then run:

```fish
ssh -N -o ExitOnForwardFailure=yes \
  -R 127.0.0.1:41434:127.0.0.1:11434 \
  -R 127.0.0.1:41537:127.0.0.1:<POLYSTRATA_PORT> \
  -R 127.0.0.1:41600:<STRATA_HOST>:<STRATA_PORT> \
  <vm-user>@<vm-host>
```

- Leave this terminal open. Closing it (Ctrl+C) removes the tunnels.
- Leave out the Strata line if Strata isn't running.
- Port 11434 in the VM is deliberately **not** used. The launcher's default AnythingLLM chat setting points there, so with nothing at 11434, AnythingLLM's own chat cannot reach your GPU by accident.

### 4.3 Confirm from the VM (read-only)

```bash
curl -sS -m 5 -o /dev/null -w 'ollama via tunnel HTTP %{http_code}\n' http://127.0.0.1:41434/api/tags
curl -sS -m 5 -o /dev/null -w 'polystrata via tunnel HTTP %{http_code}\n' http://127.0.0.1:41537/v1/models
curl -sS -m 5 -o /dev/null -w 'strata via tunnel HTTP %{http_code}\n' http://127.0.0.1:41600/models
```

Expect `HTTP 200` for each running engine. For an Ollama-style Strata, use `/api/tags` on the third line.

## 5. Stage 4: launch the isolated instance (VM)

Use a new VM terminal:

```bash
cd ~/nytedesk-verify/anything-llm
export NYTEDESK_ENABLED=true
tools/linux-run.sh
```

- **First run:** it installs dependencies for server, collector and frontend, runs `prisma generate` and `migrate deploy`, builds the frontend and stages it. This takes several minutes.
- **Expected end:** "Your fork is ready: http://127.0.0.1:3002" and "Keep this terminal open. Press Ctrl+C to stop both services."
- **Logs:** `server/storage/fork-logs/server.log` and `collector.log`.
- **Network:** on start, AnythingLLM fetches public model metadata (context-window and pricing maps) from the internet into `server/storage/models/`. This is unrelated to your engines.
- **Expected harmless log lines:** "[Ollama] Error caching context windows: fetch failed". AnythingLLM's own chat points at `127.0.0.1:11434`, where nothing listens in the VM, by design (see §4.2).
- **Failure cases:** "Port 3002/8889 is already in use" (another instance is running, so nothing was changed), "This checkout is already running or building", or "Startup did not complete" (the last log lines are printed).

`NYTEDESK_ENABLED=true` is read from your shell. The launcher's generated `server/.env` doesn't set it, and existing shell variables take precedence over that file.

**Open the page:**
- **Browser in the VM:** go to `http://127.0.0.1:3002`.
- **Browser on the desktop:** start a second desktop terminal with `ssh -N -L 127.0.0.1:13002:127.0.0.1:3002 <vm-user>@<vm-host>`, then open `http://127.0.0.1:13002` on the desktop.

## 6. Stage 5: first-time setup in the browser

The launcher writes LLM settings into `server/.env`, so AnythingLLM treats the instance as already set up. **There is no onboarding wizard:** the instance opens in **single-user mode with no password**. It listens only on the VM's `127.0.0.1`, but enable multi-user mode first. NyteDesk requires it, and until it is on, anyone who can reach that port has full access. (Rehearsed in CI: see §11.)

1. **Enable multi-user mode:** open `http://127.0.0.1:3002/settings/security`. Click **Enable Multi-User Mode**, enter the **admin** username and password, and click **Save changes**.
   - "Multi-User mode enabled successfully." appears, and after about 2 s you are sent to sign in.
   - The browser console may show "Cannot read properties of undefined (reading 'preventDefault')". That comes from upstream AnythingLLM's Security page; the change still saves.
2. **Sign in as admin.** On the first sign-in AnythingLLM shows recovery codes: click **Download**, then **Close**. Keep the file private, or delete it after the session.
3. As admin, open **Settings → Users** (`/settings/users`), choose **Add user**, and create a **manager** and a **default** user.
4. Create a workspace named `NyteDesk Verify` with the new-workspace button in the sidebar. Then open its settings → **Members** → **Manage Users**, tick the default user, and click **Save**.
5. Open **`/nytedesk`**.

You don't need to change AnythingLLM's own LLM setting. It stays on Ollama at `127.0.0.1:11434`, where nothing listens in the VM, so chat and uploads won't work in this instance. That is deliberate: it keeps them off your GPU (see §6.3).

### 6.1 Engine configuration in Local AI Manager (admin, read-only toward the engines)

| Engine | Endpoint | Other fields |
|---|---|---|
| PolyStrata | `http://127.0.0.1:41537/v1` | model `qwen3.6-35b-a3b-ud-q2_k_xl`, context `32768`, VRAM reserve `1024` |
| Ollama | `http://127.0.0.1:41434` | model as listed |
| Strata | `http://127.0.0.1:41600` (add `/v1` if its OpenAI routes live there) | API type: `openai` or `ollama`, as applicable |

For each engine: **Configure → Save → Check**. Then **Select** PolyStrata.

### 6.2 Expected engine behaviour

| Check | Expected |
|---|---|
| Check on a running engine | "reachable", the model list, and the configured model "listed" |
| Wrong port, for example `:41599` | "unreachable", `CONNECTION_REFUSED`; Select unavailable, with the reason shown |
| Non-loopback endpoint, for example `http://192.168.1.10:11434` | Refused on save (`INVALID_ENDPOINT`) |
| Selection after changing the endpoint | Blocked until a fresh check |
| Start, stop, restart, unload or kill | No such controls; the cards say "externally owned · start/stop disabled" |
| Desktop `/api/ps` and `nvidia-smi` afterwards | Same loaded models and VRAM as the §4.1 baseline |

### 6.3 Chat (owner decision)

Check that the embedded chat **renders** (prompt box, workspace selector, coordinator label), but **don't send a message** by default. Sending one would make the selected AnythingLLM provider load a model.

If you decide to test a reply, note it in the evidence along with the engine and model used. Expect VRAM to change while the model is loaded. That comes from AnythingLLM's chat, not from NyteDesk.

## 7. Owner acceptance checklist

Mark each item ✅, ❌ (with a note) or n/a.

### 7.1 User interface (admin)
- [ ] Dashboard at 1440 px wide matches the approved concept layout: navigation, KPI row, chat, right sidebar.
- [ ] Phone width (≈390 px, browser responsive mode) and tablet width (768 and 1024 px) are usable, with no horizontal scrolling.
- [ ] Navigation collapses, and the choice survives a reload.
- [ ] The sidebar divider drags; arrow keys, Home and End resize it when it's focused; double-click resets it; the width survives a reload.
- [ ] The account button (initials) sits in the top bar and doesn't cover the text-size or refresh controls.
- [ ] Text size: 10–22 px, live update, Normal (14 px) reset, keyboard operable, Escape closes it, and it persists after a reload. Headings and code in chat scale with it.
- [ ] Freshness shows "Updated …" (or a short label on narrow screens), with Refreshing, Stale and Failed states and a manual refresh.
- [ ] Light and dark themes (Settings → UI Preferences) both look correct.
- [ ] Keyboard only: you can reach every navigation item, the command bar (Ctrl+K), the divider and the text-size control.
- [ ] Phone width drawer: it opens; Tab and Shift+Tab stay inside; Escape or tapping outside closes it; focus returns to the menu button. Widening the window while it's open closes it and moves focus to the desktop navigation.

### 7.2 Authorization
- [ ] Admin can configure, check and select engines; the manager can only check; the default user is read-only.
- [ ] Host telemetry: admin and manager see CPU/RAM; the default user sees "Restricted".
- [ ] Direct request (in the browser console, signed in as the default user):
  ```js
  fetch("/api/nytedesk/telemetry",{headers:{Authorization:"Bearer "+localStorage.getItem("anythingllm_authToken")}}).then(r=>r.status)
  ```
  Expect `403`. This prints only the status; never copy the token itself. Signed in as admin, the same line returns `200`.
- [ ] Signed out, or in a private window: `http://127.0.0.1:3002/api/nytedesk/telemetry` → `401`.
- [ ] Self-approval: the manager proposes a task, opens it, and sees "You requested this task…"; there is no Approve button.
- [ ] Protected action: the default user proposes `vm.write`; the manager sees "Only an administrator…"; the admin can decide.

### 7.3 Approval integrity
- [ ] Inspector shows the exact operation, provenance, resources/files, risk and permissions, evidence (payload hash, audit chain "Verified") and audit history.
- [ ] Approve stays disabled until "I reviewed…" is ticked. Opening a different task, or the same task after it changed, clears the tick.
- [ ] **Concurrency:** the default user proposes a `repository.read` task. Admin and manager open it in two browsers. The admin approves; then the manager clicks Approve. The manager gets an error ("not awaiting approval" or a version conflict), the page reloads, and the task shows *Approved by* the admin.
- [ ] The audit history lists creation and decision with actor and role.
- [ ] After approval the state is "Approved" and nothing runs. Logs & Diagnostics shows execution disabled, and AgentBridge shows every precondition "Not verified".

### 7.4 Telemetry
- [ ] CPU % and RAM are plausible **for the VM** (the NyteDesk server host, not the GPU desktop). "Updated Ns ago" advances, and the data is marked Stale if it stops updating.
- [ ] GPU utilization, VRAM, temperature, tokens/s and context usage show **Unavailable**, with a reason.
- [ ] No inference statistics appear anywhere without a source.
- [ ] VM process list during the session shows no `nvidia-smi` or shell children of the server:
  ```bash
  ps -eo pid,ppid,args | grep -E '[n]ode index.js|[n]vidia-smi'
  ```

### 7.5 Reliability
- [ ] In a second browser, the default user proposes a task. In the first, click away and back: the dashboard updates (focus refresh, at most one every 5 s; otherwise within 30 s).
- [ ] Hidden tab: switch to another tab for 2 minutes, then return. Freshness may show Stale, then refreshes.
- [ ] Failure and recovery: stop the tunnel terminal and Check an engine → "unreachable". Restart the tunnel and Check again → "reachable". The engines themselves are untouched.
- [ ] Navigating between sections and to `/workspace/<slug>` and back works cleanly. The browser console shows no uncaught errors. Console warnings from AnythingLLM itself are acceptable; note them.
- [ ] Server memory is stable over about 10 minutes idle on the dashboard. Note the RSS at the start and the end:
  ```bash
  ps -eo pid,rss,etime,args | grep '[n]ode index.js'
  ```

## 8. Evidence collection

Create an evidence folder (VM):

```bash
mkdir -p ~/nytedesk-verify/evidence && cd ~/nytedesk-verify/anything-llm
{ echo "date: $(date -Is)"; echo "head: $(git rev-parse HEAD)"; echo "accepted code: 1d2706897de03966dc52519363036330d86507bc"; uname -sr; } > ../evidence/01-environment.txt
tools/linux-run.sh --check-toolchain >> ../evidence/01-environment.txt 2>&1
```

- Save the Stage 2 test tail as `02-fork-tests.txt`.
- Save the §4.1 and §4.3 outputs as `03-engines-before.txt`, and the repeat after the session as `04-engines-after.txt`.
- Server log errors only, reviewed before sharing:
  ```bash
  grep -iE 'error|nytedesk' server/storage/fork-logs/server.log | tail -n 200 > ../evidence/05-server-log-excerpt.txt
  ```
- Take screenshots of: the dashboard (desktop, phone and tablet widths), Local AI Manager after the checks, the inspector (admin, plus the manager self-request view), the default user's "Restricted" metrics, and the concurrency error.

**Never collect:** tokens, passwords, `server/.env`, cookies, or unrelated system information.

### Evidence template

| Area | Result | Evidence file or screenshot | Status |
|---|---|---|---|
| Checkout SHA and docs-only diff | | 01-environment.txt | Locally verified |
| Fork tests 135/135 | | 02-fork-tests.txt | Locally verified |
| PolyStrata check, list, select | | screenshot | Owner verified |
| Strata check, list, API type | | screenshot | Owner verified |
| Ollama check, list | | screenshot | Owner verified |
| Engines unchanged (`/api/ps`, VRAM before = after) | | 03/04 | Owner verified |
| UI checklist §7.1 | | screenshots | Owner verified |
| Authorization §7.2 | | console statuses, screenshots | Owner verified |
| Approval integrity §7.3 | | screenshots | Owner verified |
| Telemetry §7.4 | | screenshot, `ps` output | Owner verified |
| Reliability §7.5 | | notes, RSS start/end | Owner verified |
| CI at `1d27068` (32/32 e2e, 135 fork, 2570 Jest, lint, build) | ✅ | PR #7 body, runs 44848801065, 44848801036, 44848801073 | CI verified |
| Defects found | | | |
| Not verified | | | |

## 9. Shutdown, rollback and cleanup

1. In the launcher terminal, press **Ctrl+C**. The launcher stops both its server and its collector, and nothing else.
2. Close the tunnel terminal(s) on the desktop (**Ctrl+C**). This removes the `-R` and `-L` forwards. The engines keep running, untouched.
3. Optional, from the desktop: repeat `/api/ps` and `nvidia-smi` and compare with the §4.1 baseline.
4. Remove the isolated instance when you're done. This deletes its databases, generated `.env`, logs and local toolchain. Keep `~/nytedesk-verify/evidence` if you still need it.
   ```bash
   rm -rf ~/nytedesk-verify/anything-llm
   ```
   No global packages, services or system configuration were changed. Outside the folder, only package caches in your home directory were created or updated: `~/.npm`, `~/.cache/yarn`, `~/.cache/prisma` and `~/.cache/prisma-nodejs` (observed in the CI rehearsal). They are safe to keep; to remove them as well:
   ```bash
   rm -rf ~/.cache/prisma ~/.cache/prisma-nodejs   # only if no other project uses Prisma
   yarn cache clean 2>/dev/null; npm cache clean --force
   ```

## 10. What happens next

- Record results with the template. Any ❌ becomes a defect for the developer and is re-reviewed independently.
- Only after owner verification passes are PR #6 and PR #7 evaluated together for integration readiness. That is a separate decision; neither is merged by this procedure.

## 11. CI rehearsal of this guide (CI-simulated, not owner verification)

Draft PR #8 (do not merge) runs this guide in GitHub Actions:
- §2 and §3 verbatim, including the docs-only diff check, `--check`, `--check-toolchain` and the fork tests;
- mock engines on the tunnel ports 41434, 41537 and 41600, and the §4.3 checks verbatim;
- `tools/linux-run.sh` with `NYTEDESK_ENABLED=true`;
- §6–§7 in Chrome;
- the §7.4 process check, §8 evidence, and §9 shutdown by SIGINT.

**Result:** every rehearsal step passed (run `44854354596`, evidence artifact `14687315570`).
- **Launch:** listeners are only `127.0.0.1:3002` and `127.0.0.1:8889`. NyteDesk reports enabled and multi-user after Settings → Security.
- **Browser procedure:** all 19 checks pass. Users, members, engine configure/check/select, non-loopback refusal, wrong-port diagnostics, the authorization matrix (including 401/403), self-approval, the protected-action rule, the two-browser approval race, execution disabled, Unavailable GPU metrics, focus refresh and tunnel drop/restore.
- **Engines and processes:** engine traffic was 8 requests, all `GET` model listings, with no model loads. There were no `nvidia-smi` or shell children of the server.
- **Shutdown:** SIGINT stopped the server and collector and released both ports; the mock engines kept running.

It does **not** cover your real engines, your hardware, the SSH tunnels themselves, or how the dashboard looks to you. Those remain for this guide.

**Known issues at the accepted code**, found by the rehearsal. Fixes are proposed in PR #8 and need independent re-review before they can enter PR #7:
- **K1:** typing in the embedded chat and then resizing the window across 1024 px clears the typed text. The chat remounts, and its auto-focus can also take focus after the mobile drawer closes.
- **K2:** "Submit for approval" (Tasks → Propose a task) logs "Cannot read properties of undefined (reading 'preventDefault')" in the console. The task is still created.
