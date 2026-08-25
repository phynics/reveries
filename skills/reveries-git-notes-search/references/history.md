# Historical search and direct inspection

Use history only when the question asks when a decision changed, why a prior implementation
existed, or which record was retired or superseded.

```bash
reveries search --all 'transition authority'
reveries history src/state.rs
reveries history rv:<full-id>
git log -p refs/notes/reveries
```

Path history walks revisions affecting the path, resolves each historical blob, shows associated
reveries and relevant session-summary entries, then follows supersession/source links. A path is
only a historical navigation mechanism; it is not an applicability identity.

For raw inspection, list notes and read their note blobs:

```bash
git notes --ref=refs/notes/reveries list
git notes --ref=refs/notes/reveries show <blob-or-commit>
```

If history is shallow, a remote note is absent, or a note is malformed, report the limitation.
Do not claim completeness or silently treat unavailable evidence as empty.
