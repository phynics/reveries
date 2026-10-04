---
name: reveries-git-notes-init
description: Prepare a Git repository for Reveries evidence. Use when explicitly asked to initialize Reveries, repair the notes merge strategy, or add the Reveries-owned AGENTS.md instructions block. Do not use for ordinary note reading, recording decisions, or rationale search.
---

# Reveries Git Notes Init

`reveries init` does two things and nothing else:

1. It sets `notes.reveries.mergeStrategy` to `cat_sort_uniq`, so two clones' notes refs
   combine by union.
2. It writes the Reveries-owned block into `AGENTS.md`, preserving all surrounding prose.

It installs no hooks, configures no publishing remote, creates no trust store, and makes no
commit. Reveries is an evidence format, not a workflow gate, so setup must not decide when a
commit or a push is allowed.

## Run it

```bash
reveries init
reveries doctor
```

`init` is idempotent. It replaces only the text between the `<!-- reveries:begin -->` and
`<!-- reveries:end -->` markers and leaves every other byte of `AGENTS.md` intact.

## What to do next

- Publish evidence with an ordinary `git push` of `refs/notes/reveries`, or use
  `reveries push <remote>` for one atomic push of HEAD and the notes ref.
- Run `reveries retain` to anchor annotated subjects under `refs/reveries/retention`, so a
  pruning `git gc` cannot remove evidence for content no longer reachable from a branch.
- To share evidence, add the fetch refspec
  `+refs/notes/reveries*:refs/notes/remotes/<remote>/reveries*` and merge with
  `cat_sort_uniq`. Never fetch automatically.

## Repair

If `AGENTS.md` lost its markers or the merge strategy is wrong, run `reveries init` again.
It rewrites only the owned block and the strategy. It never deletes `refs/notes/reveries`.
`reveries doctor` reports the state without changing anything.
