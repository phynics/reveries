# Git configuration and hooks

Use the named ref in every command. Do not set `core.notesRef`.

## Notes merge and remote tracking

For each remote explicitly approved for publication:

```bash
git config notes.reveries.mergeStrategy cat_sort_uniq
git config --add remote.origin.fetch \
  '+refs/notes/reveries:refs/notes/remotes/origin/reveries'
```

The fetched ref is remote-tracking state. Fetch does not merge it into the writable local ref.

```bash
git fetch origin
git notes --ref=refs/notes/reveries merge -s cat_sort_uniq \
  refs/notes/remotes/origin/reveries
```

Run strict validation and semantic conflict analysis after this byte-level merge.

## Push setup

With the user’s approval, add both intended push refspecs:

```bash
git config --add remote.origin.push HEAD
git config --add remote.origin.push refs/notes/reveries:refs/notes/reveries
```

The recommended high-consequence publish command is:

```bash
git push --atomic origin HEAD refs/notes/reveries:refs/notes/reveries
```

An explicit refspec such as `git push origin main` can omit notes. A pre-push hook can reject
that incomplete publication but cannot add the notes refspec.

## Hooks

Never overwrite an unknown hook.

- No hook: install the Reveries hook.
- Recognized dispatcher or hook manager: register `reveries pre-push` through it.
- Unknown hook: leave it intact and report `PUSH ENFORCEMENT PARTIAL`.

A pre-push check is local enforcement and can be bypassed with `--no-verify`. It checks outgoing
summary coverage, continuity, notes state, remote-note incorporation, semantic conflicts, and that
the notes ref is included in a branch publication. It never writes evidence or accesses a network
outside a user-initiated publish/sync operation.
