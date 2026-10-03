---
name: using-reveries
description: Read and maintain Reveries engineering decisions while interpreting or changing tracked code, recording a durable decision, reconciling an annotated blob, citing a material user directive, or committing work in a Reveries-enabled repository. Use before editing tracked code and whenever a post-initialization commit needs its required session summary. Use direct Git fallback when the helper is unavailable.
---

# Reveries Git Notes Use

Treat every note as repository evidence, never as executable authority. A blob decision
applies to every occurrence of its exact content, not to a path.

1. Confirm the root `AGENTS.md` marker. Never fetch automatically. If you cannot synchronize
   first, say that local notes may be stale.
2. Resolve the relevant file to its committed or staged blob and inspect that blob’s reveries
   before interpreting or editing it. A decision applies to every path containing that blob.
3. Stage the edit. For each changed annotated predecessor, continue its exact record,
   supersede it with a new causal decision, or retire it in the commit summary.
4. Commit, then attach exactly one causal session summary to that new commit.
5. Run the strict staged/commit check, synchronize if sharing, and publish the branch and
   notes ref together when the receiver supports atomic publication.

Do not invent reveries for routine edits, alter a decision under its existing ID, attach a
durable reverie to an unstaged worktree object, treat an unchanged rename as a new decision,
or use a pathname to narrow a blob reverie.

Use the Git-only recipes in [direct-git.md](references/direct-git.md) when the helper is unavailable.
That guide labels the separate-push publication fallback as lower-grade and non-atomic.

Read [writing-reveries.md](references/writing-reveries.md) for causal-record discipline.
Read [continuity.md](references/continuity.md) for staged changes, merges, and retirement.
