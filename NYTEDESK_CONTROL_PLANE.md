# NyteDesk control plane — Phase 1 (prototype)

Branch: `feature/nytedesk-control-plane-phase1`
Base: `feature/archive-source-review`

## Scope

This introduces a **planning-only** CommonJS state machine in
`server/utils/nytedesk/control-plane.cjs`, with focused node:test cases.
Nothing is wired into HTTP routes or the UI. It does not call Anthropic,
OpenAI, Ollama, Strata, browsers, shells, the VM, or GitHub.

A task carries workspace and requester identifiers, its selected model adapter,
the proposed action, a monotonic event sequence, and an in-memory audit
snapshot. Every known action—including reads—is currently approval-gated.
Decisions require an independent actor and a decision identifier. Approved
tasks can transition through running to succeeded/failed; denial/cancellation
are terminal. All transitions reject stale versions.

**Not a security boundary by itself:** The state-machine module trusts its
caller-supplied actor identity. A future authenticated, transactional service
MUST derive caller identity from a verified session, enforce workspace roles,
bind an approval to an exact immutable task payload, persist the complete audit
log, reject replayed decision identifiers, and check cancellation at execution
time. It MUST reauthorize immediately before any tool execution. Do not expose
`transition` directly to untrusted clients or enable executable adapters.

## Test

```sh
node --test tests/fork/control-plane.test.cjs
node --test tests/fork/*.test.cjs
```

These are unit tests only; full application build and live VM/model/browser
integration remain unverified.

## Implementation phases

1. **Now:** pure task states, fail-closed action catalog, audit trail,
   regression tests, isolated draft PR.
2. **Next:** authenticated UI/API, durable append-only event store, transaction
   boundaries and versioning, task queue, idempotent decision handling,
   separate read/execute roles, explicit credential storage.
3. **Then:** Ollama and Strata adapters with limited prompt-only permissions;
   Anthropic/OpenAI API adapters with independently configurable costs,
   deadlines, tokens, opt-in external disclosure and streaming.
4. **Finally:** separately deployed VM agent and browser worker. Each must be
   separately authenticated, with an explicit allowlist, isolation verified
   against the host/shared folders/LAN, bounded time/output/resources,
   egress controls, human confirmation of destructive/external operations,
   emergency stop, and tamper-evident evidence.

Use official APIs for Claude/OpenAI. Their web subscriptions do not grant API
usage, and automating personal web sessions should not be the default.

## Review requirements

- Unit tests on GitHub Actions must pass.
- Independent security review before wiring network or command execution.
- No migration, service installation, VM reset, credentials, or host changes
  are authorized by the existence of this branch.
- Do not merge until the user has reviewed the phase and its limits.
