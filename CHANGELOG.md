# Changelog

## 2.0.0 - 2026-10-04

Reveries is now a small Git-native evidence system. The authoritative state is Git objects,
`refs/notes/reveries`, and `refs/reveries/retention`; nothing else is required.

- Define `reverie` (blob, tree, or exact region) and `lineage` as the only record types. A
  reader skips unknown record types without interpreting or rejecting them, so earlier bytes
  stay readable.
- Add region evidence: identity is the blob plus the Git hash of the selected bytes; line
  numbers are navigation hints only.
- Replace commit-attached continuity with explicit `link` edges on endpoint objects, so an edge
  survives a rebase. Kinds are `preserve`, `split`, `merge`, `derive`, and `retire`.
- Collapse retention to a single `refs/reveries/retention` ref and expose `reveries retain`.
- Remove the adoption boundary, mandatory session summaries, outgoing and receive gates,
  hosted workflows, merge bots, host adapters, the ledger envelope, signing and trust,
  authority and roles, redaction, transitions and attestations, corrections and resolutions,
  and occurrence records.
- Remove the `summarize`, `check`, `adopt`, `hooks`, `ledger`, `sign`, `authority`, `redact`,
  `transition`, and `receive-check` commands. `doctor` reports integrity only and exits
  non-zero only for damage.
- Rewrite `scripts/direct-git-acceptance.mjs` to prove the 20 PRD acceptance criteria against
  the built CLI and raw Git, and gate `npm run verify` on it. CI is one workflow on Node 22 and
  the Git 2.39 container.

## 1.0.2 - 2026-08-25

- Make initialization choices explicit, including local-only, no-host, and no-directive-email
  setups.
- Add reminder, pull, vendored, and linked project Skill delivery with tracked ownership and
  collision-safe removal, plus pinned Git-submodule delivery for the complete Skill set.
- Bind adoption to an immutable plan and exact commit, preserving unrelated staged work and
  attaching both required records atomically.
- Keep ordinary fetches working before the remote notes ref exists, validate hook runners and
  owned hook bodies, and keep pre-adoption hooks quiet.
- Add Pi 0.84.1 Skill-routing evidence and expanded setup, concurrency, recovery, and installer
  acceptance coverage.

## 1.0.1 - 2026-08-25

- Write canonical JSONL notes through a portable read-concatenate-replace transaction so the
  helper works with Git 2.39 as well as newer clients.
- Make the stale-clone acceptance fixture independent of global Git identity.
- Include captured test output in evaluator failures and run the suite against Git 2.39 in CI.

## 1.0.0 - 2026-08-25

Reveries V1 provides Git-notes engineering memory for exact file blobs and commits.

- Store canonical JSONL reveries, session summaries, and the adoption record in
  `refs/notes/reveries`.
- Enforce explicit continuation, supersession, or retirement when annotated blobs change.
- Require one causal session summary for every published post-adoption commit.
- Provide initialization, inspection, recording, checking, search, synchronization, publication,
  and hook commands through the optional TypeScript CLI.
- Provide `reveries-git-notes-init`, `using-reveries`, and
  `reveries-git-notes-search` for Pi, Claude Code, OpenCode, Codex, and Gemini CLI.
- Support reminder-only, pull-when-missing, and vendored Skill delivery for newly arriving agents.
- Verify all 46 claimed V1 acceptance criteria. Automatic delivery remains unclaimed; every host
  is graded `CORE`.
