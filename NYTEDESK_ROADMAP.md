# NyteDesk — Master Development Roadmap

Version: 1.0 · November 19, 2026
Status: Planning document; statuses refer to verified development activity, not production readiness.

## Product objective

NyteDesk will extend `nyteghost/anything-llm` into a local-first AI workspace. Its local LLM (Ollama, Strata, or PolyStrata) proposes plans and coordinates assignments through AgentBridge. Claude Code CLI and OpenAI Codex CLI carry out bounded development tasks inside isolated workspaces and a dedicated VM. NyteDesk provides project context, chat, task/status views, approvals, logs, evidence, and engine management. **Supervised** is the default operating mode.

## Current baseline

- The existing AnythingLLM fork on `feature/archive-source-review` supports archive/script imports, source file manifests, paged numbered reads, and coverage reports. Independent full-system QA remains necessary.
- The owner successfully ran the fork locally at `http://127.0.0.1:3002` with `tools/linux-run.sh`.
- The owner successfully connected a running PolyStrata server to the fork using Generic OpenAI. Model: `qwen3.6-35b-a3b-ud-q2_k_xl`, 32768 context; the 10 GiB RTX 3080 required `--vram-reserve-mib 1024`. The successful session used `http://127.0.0.1:40537/v1`; this is a *session port*, not a permanent default.
- Ollama is installed and available separately. Strata integration remains to be confirmed.
- Open draft PR #1: authenticated persistent task API and approval dashboard. Unmerged; independent QA pending.
- Open draft PR #2: adjustable chat font slider 10–22 px, persistent preference, legacy size migration. Unmerged; frontend build/visual QA pending.
- Open draft PR #3: Local AI Manager engine registry and read-only policy foundation. Unmerged; no live process controls.
- There is no verified interactive VM connection from ChatGPT chat. Host, mounts and other devices must remain unaffected.

## M1 — Stabilize foundation and source intelligence

- [ ] Verify clean CachyOS installation, source branch, dependencies and reproducible build.
- [ ] Run focused tests and applicable CI; verify the app's frontend, collector and server.
- [ ] End-to-end test ZIP/source ingestion, numbered reads, manifest, pagination, coverage, and agent review.
- [ ] Confirm uploads are data, not executable instructions, and preserve existing AnythingLLM data.
- [ ] Document installation/backup/restore and troubleshooting.

Acceptance: reproducible clean run and successful source-review demo.

## M2 — Professional NyteDesk dashboard and usability

- [ ] Review PR #2, build frontend, inspect slider visually and confirm persistence.
- [ ] Consistent NyteDesk branding and professional work-focused navigation.
- [ ] Project, Chat, Agents, Tasks, Approvals, Logs, Memory, Local AI Engines, Settings views.
- [ ] Usable approvals, evidence previews, activity/progress, errors and help.
- [ ] Responsive layouts, keyboard accessibility and preference persistence.

Acceptance: end-to-end navigation and actual task/status integration, not a mockup.

## M3 — Local AI Manager (near-term priority)

- [x] Review PR #3 registry and safety tests (integrated in PR #6).
- [x] Configure Ollama, Strata and PolyStrata endpoint/model registration; never hardcode an ephemeral port (PR #6).
- [x] Health probes, readiness state, model discovery and active-model display (PR #6; read-only, externally owned engines).
- [ ] Secure process lifecycle with fixed allowlisted executable/arguments, separate local authenticated controller, exact process ownership and resource limits.
- [ ] One-click start/connect/switch/stop (with explicit confirmation before affecting an independently running service).
- [ ] VRAM/RAM usage, safe engine-switch memory budget, graceful unload, idle behavior, failure recovery.
- [ ] Maintain functioning local inference and avoid changing unrelated services.

Acceptance: repeated verified switching with evidence and no disruption to other processes. Do **not** offer executable controls until ownership/authorization is independently tested.

## M4 — AgentBridge control plane, approvals, memory

- [ ] Review and stabilize PR #1; ensure authenticated identity and per-workspace roles.
- [ ] Immutable task payloads, approval binding, replay protection, atomic state transitions, idempotency.
- [ ] Durable event/audit store, cancellation, queue, restart recovery and failure handling.
- [ ] Evidence ledger, task delegation contract, model/provider provenance and spending limits.
- [ ] Project-scoped context, resumable decisions, optional carefully reviewed OpenViking adapter.
- [ ] Enforce safety in deterministic host-side policy, never trust local model to self-authorize.

Acceptance: post-restart recovery with correct roles, approvals and complete evidence.

## M5 — Claude Code CLI + OpenAI Codex CLI

- [ ] Common adapter interface: tasks, streams, typed results, logs, cancellation, deadlines, model quotas and cost.
- [ ] Claude Code CLI installation/authentication and scoped permission configuration.
- [ ] Codex CLI installation/authentication and sandboxed noninteractive operation.
- [ ] Isolated worktrees for developer and independent QA roles; no accidental shared writes.
- [ ] Safe capture of commits, diffs, test results and review findings; secrets never in logs.
- [ ] Explicit user-visible distinctions between CLI agent access and ChatGPT/Claude web subscriptions and conversations.

Acceptance: local coordinator delegates implementation and independent review, with auditable results and no unapproved side effects.

## M6 — Secure VM and optional browser control

- [ ] Inspect isolation: host mounts, shared folders, devices, network/egress and account permissions.
- [ ] Snapshot/recovery strategy without destructive host operations.
- [ ] Dedicated VM-local authenticated execution gateway, initially read-only.
- [ ] Bounded scoped file writes, build/test execution, process ownership, quotas and emergency stop after security acceptance.
- [ ] Optional browser worker for supported web interfaces; separate authorization, screenshots and sensitive action gates.
- [ ] Adversarial testing: prompt injection, path traversal, race/TOCTOU, shell escape, identity spoofing and network escape.

Acceptance: independent security review and repeatable isolation test, before production execution access.

## M7 — Supervised multi-agent workflow and later bounded autonomy

- [ ] Local LLM proposes scoped plan; AgentBridge checks policy.
- [ ] Claude implements in isolated worktree; tests run in VM.
- [ ] Codex independently reviews; findings feed remediation loop.
- [ ] Evidence-rich task timeline, checkpoints, resumability and budget enforcement.
- [ ] Explicit approval for merges, deployments, publication, credential access and protected actions.
- [ ] Optional bounded-autonomy mode only after supervised mode passes independent QA.

Acceptance: reproducible full task cycle with no self-approval, policy bypass or unauthorized host effects.

## M8 — Hardening and release

- [ ] Supply chain/dependency checks, CI, security audits and backup/restore rehearsal.
- [ ] Crash recovery, performance, resource limits, telemetry/privacy review and error diagnostics.
- [ ] Native/offline-friendly CachyOS launcher and polished onboarding.
- [ ] Documentation and acceptance testing on a clean host/VM profile.
- [ ] Windows/portable package only after Linux release is stable and separately approved.

Acceptance: repeatable secure clean install, tested update procedure and owner acceptance.

## Sequencing and coordination

Immediate: stabilize M1 and PR #1; verify PR #2 UI and PR #3 registry independently; then complete M3 health/selection UI without unreviewed process actions. M4 authorization is a prerequisite for executable M5/M6 features. M7 begins only after proven isolation, role enforcement and tests. Keep development on separate branches; no unreviewed merges.

## Non-negotiable guardrails

- No host modifications, shared folder operations, LAN device changes, or unrelated service termination.
- No unrestricted shell or browser control, no process-name killing, no unverified remote endpoints.
- No credentials in source, prompts, logs or agent-visible workspaces.
- No unbounded token/cost usage or silent escalation from read to write.
- Independent approval for destructive/external operations.
- Model output and retrieved files are untrusted.
- The local coordinator never grants its own privileges.

## References

- [PR #1 — Task control plane](https://github.com/nyteghost/anything-llm/pull/1)
- [PR #2 — Chat text-size slider](https://github.com/nyteghost/anything-llm/pull/2)
- [PR #3 — Local AI Manager foundation](https://github.com/nyteghost/anything-llm/pull/3)
