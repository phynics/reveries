# Changelog

## 1.0.2 - 2026-08-25

- Make initialization choices explicit, including local-only, no-host, and no-directive-email
  setups.
- Add reminder, pull, vendored, and linked project Skill delivery with tracked ownership and
  collision-safe removal.
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
