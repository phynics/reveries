---
name: reveries-git-notes-init
description: Initialize, inspect, repair, upgrade, remove, or diagnose Reveries Git-notes engineering memory in a Git repository. Use only when explicitly asked to configure Reveries, choose publishing remotes or supported hosts, edit Reveries-owned instruction blocks, install or compose hooks, or repair a Reveries setup. Do not use for ordinary note reading, decision maintenance, or rationale search.
---

# Reveries Git Notes Init

Prepare an idempotent, conservative local installation. The Git notes ref is evidence
and remains untouched by normal removal.

1. Confirm the repository is a Git worktree and inspect the marker, notes ref, hooks,
   remotes, and current protocol state.
2. Ask how agents should obtain `using-reveries`, which hosts to support, which remote
   or remotes publish Reveries, and which Git email identifies material user directives.
   Never infer any of these choices.
3. Present the intended tracked-file, Git-config, and hook changes before changing them.
4. Apply the selected Skill setup, then add only the owned marker blocks. Preserve other
   instruction prose and unknown hooks.
5. Configure the notes merge strategy and selected remote refspecs, then run `doctor`.
6. Leave initialization changes uncommitted. Print the commands for the adoption commit,
   its session summary, initialization record, strict check, and first atomic push.

Do not create a commit, push, install global software, choose a remote, overwrite an
unknown hook, or delete `refs/notes/reveries` without explicit authorization.

Read [initialization.md](references/initialization.md) for the workflow and owned blocks.
Read [git-config.md](references/git-config.md) before changing Git configuration or hooks.
Read [troubleshooting.md](references/troubleshooting.md) for repair, upgrade, removal, or
partial-enforcement cases.
