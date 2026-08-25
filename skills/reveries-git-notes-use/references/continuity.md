# Continuity before commit

## Normal sequence

```text
inspect active blob reveries → edit → stage → analyze predecessors
→ continue / supersede / prepare retirement → commit → summarize
→ strict check → synchronize → publish branch and notes
```

Only write durable reveries to a staged blob or an already committed blob. An arbitrary worktree
hash can become unreachable and must be refused.

For every active reverie on an annotated predecessor blob affected by the commit:

- **Continue** it when the causal statement remains true. Put the identical canonical line on the
  successor blob.
- **Supersede** it when causal content changes. Attach a new record to the successor blob whose
  `supersedes` contains the old ID.
- **Retire** it when it no longer applies. Put
  `{reverie, from_blob, reason}` in the session summary; state why the abstraction, constraint,
  or risk ceased to apply.

A pure rename or exact copy needs no action. An edit never inherits evidence silently. When
rename-plus-edit mapping is ambiguous, supply `--successor old/path.rs=new/path.rs`; do not guess.
Deletion without a successor retires every active reverie.

## Merges and conflicts

Evaluate continuity independently from every merge parent. A clean content merge does not reconcile
the rationales. A strict reader rejects cycles and unresolved forks: when two terminal decisions
supersede the same predecessor and meet on one blob, create a further reverie superseding both or
causally retire one terminal decision.

## Commit account

After committing, attach one valid session summary to that exact commit. Use multiple entries for
genuinely distinct changes. List new reveries and material supersessions, but not ordinary
continuations. Rewritten commits are new objects and need fresh summaries.
