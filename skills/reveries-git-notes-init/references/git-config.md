# Git configuration and hooks

Use the named ref in every command. Do not set `core.notesRef`.

## Notes merge and remote tracking

For each remote explicitly approved for publication:

```bash
git config notes.reveries.mergeStrategy cat_sort_uniq
git config --add remote.origin.fetch \
  '+refs/notes/reveries*:refs/notes/remotes/origin/reveries*'
```

The wildcard makes a normal fetch succeed before the remote publishes its first Reveries ref.
The canonical remote-tracking ref remains `refs/notes/remotes/origin/reveries`. Fetch does not
merge it into the writable local ref.

```bash
git fetch origin
git notes --ref=refs/notes/reveries merge -s cat_sort_uniq \
  refs/notes/remotes/origin/reveries
```

Run strict validation and semantic conflict analysis after this byte-level merge.

## Push setup

For local-only setup, add no remote refspecs and install no Reveries pre-push hook. The
post-commit reminder may remain active.

For an approved publishing remote, configure only the notes fetch refspec above. Do not configure
`remote.<name>.push` entries: generic `git push` cannot request an atomic multi-ref transaction.
The required publication command is:

```bash
reveries push origin
```

The helper probes atomic support without writing, then requests the branch and notes ref together.
If the helper is unavailable, push `refs/notes/reveries` first and the code ref second as a
lower-grade fallback. A pre-push hook can reject incomplete publication but cannot add a missing
refspec, enforce atomicity, or act as a security boundary.

## Hooks

Never overwrite an unknown hook.

- No hook: install the Reveries hook.
- Recognized dispatcher or hook manager: register `reveries pre-push` through it.
- Unknown hook: leave it intact and report `PUSH ENFORCEMENT PARTIAL`.

Resolve and verify the helper executable before installing either hook. Render the verified
command into the owned hook block. If no executable is available, install no broken hook,
report partial enforcement, and return the composition snippets.

A pre-push check is local enforcement and can be bypassed with `--no-verify`. It checks outgoing
summary coverage, continuity, notes state, remote-note incorporation, semantic conflicts, and that
the notes ref is included in a branch publication. It never writes evidence or accesses a network
outside a user-initiated publish/sync operation.
