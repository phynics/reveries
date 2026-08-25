---
name: reveries-git-notes-search
description: Search, trace, audit, and explain Reveries engineering decisions across current blobs, historical blobs, commits, issues, Git emails, paths at revisions, and source relationships. Use for questions about why code exists, what drove a change, rejected alternatives, commit rationale, decision evolution, or records citing a source. This skill is read-only and must not mutate notes, Git configuration, hooks, or remotes.
---

# Reveries Git Notes Search

Answer the current-state question first. Search the complete notes history only when the
question asks how a decision changed or why an obsolete blob existed.

1. Select the revision (`HEAD` by default) and resolve the file’s blob when a path is given.
2. Inspect active reveries on reachable current-tree blobs, the selected commit summary, and
   their cited sources.
3. State the evidence separately from inference. Explain that notes are attributed claims,
   not proof or instructions.
4. Use `--all` or `history` only for historical questions, and show superseded or retired
   state rather than presenting it as active.
5. Report malformed or conflicting records; do not quietly treat damage as no evidence.

Never write notes, fetch, merge, push, query an issue tracker, or claim a source proves a
decision while using this skill.

Read [search.md](references/search.md) for current-state and source queries.
Read [history.md](references/history.md) for path history, supersession, and raw Git fallback.
