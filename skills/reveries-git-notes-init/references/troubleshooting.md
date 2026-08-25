# Repair, upgrade, and removal

## Diagnose first

Use `reveries doctor` when available. It should report worktree, marker, protocol, notes ref,
selected remotes, fetch/push refspecs, merge strategy, hook composition, adapter grade,
initialization boundary, notes divergence, and record damage.

Treat malformed notes, unresolved notes merge state, shallow history, ambiguous successors, and
missing remote notes as conditions that preserve raw inspection but block strict claims of safety.

## Repair and upgrade

Do not rewrite old records to repair them. Correct a reverie by creating a new decision that
supersedes it. Correct a session summary by replacing the effective summary with
`correction_reason`; notes-ref history preserves the original.

A future incompatible protocol uses another ref, such as `refs/notes/reveries-v2`, rather than
silently rewriting V1. Report what the helper reads and writes; do not pretend a migration happened.

## Normal removal

Normal uninstall removes only owned AGENTS/host blocks, Reveries-added local Git configuration,
and registered Reveries hook integration. It disables activation but leaves
`refs/notes/reveries` intact locally and remotely.

Deleting evidence is separate, explicit, and destructive:

```bash
git update-ref -d refs/notes/reveries
git push origin :refs/notes/reveries
```

Do not run either command as part of normal removal.
