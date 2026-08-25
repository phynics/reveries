# Changelog

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
