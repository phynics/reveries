---
name: reveries-git-notes-init
description: Initialize, inspect, repair, upgrade, remove, or diagnose Reveries Git-notes engineering memory in a Git repository. Use only when explicitly asked to configure Reveries, choose publishing remotes or supported hosts, edit Reveries-owned instruction blocks, install or compose hooks, or repair a Reveries setup. Do not use for ordinary note reading, decision maintenance, or rationale search.
---

# Reveries Git Notes Init

Prepare an idempotent, conservative local installation. The Git notes ref is evidence
and remains untouched by normal removal.

1. Confirm the repository is a Git worktree and inspect the marker, notes ref, hooks,
   remotes, and current protocol state.
2. Before running `reveries init`, ask four separate questions:
   - How should agents obtain the Reveries Skills: reminder, pull, vendored copy,
     project-local symlinks, or a pinned Git submodule?
   - Which hosts should use the setup? "No host adapters" is valid.
   - Which remotes should publish Reveries? "Local only" is valid.
   - Which Git email identifies material user directives? "Leave unset" is valid.
   Never infer an answer. Map every answer to an explicit CLI flag, including each
   `--no-*` choice.
3. Present the intended tracked-file, Git-config, and hook changes before changing them.
4. Apply the selected Skill setup, then add only the owned marker blocks. Preserve other
   instruction prose, unrelated worktree changes, and unknown hooks.
5. Configure the notes merge strategy and selected remote refspecs, then run `doctor`.
6. Leave initialization changes uncommitted. Use the returned adoption plan with
   `reveries adopt`; it verifies every prepared file, excludes unrelated staged work, creates
   the exact adoption commit, and atomically attaches its generated summary and initialization
   records. Print the strict check and first atomic push when a publishing remote was selected.

Do not create a commit, push, install global software, choose a remote, overwrite an
unknown hook, or delete `refs/notes/reveries` without explicit authorization.

Read [initialization.md](references/initialization.md) for the workflow and owned blocks.
Read [git-config.md](references/git-config.md) before changing Git configuration or hooks.
Read [troubleshooting.md](references/troubleshooting.md) for repair, upgrade, removal, or
partial-enforcement cases.
