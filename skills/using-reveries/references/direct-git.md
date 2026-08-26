# Direct Git fallback

Use these commands when the optional helper is unavailable. They do not replace strict semantic
validation, but they keep storage readable and writable without a proprietary database.

## Inspect

```bash
git notes --ref=refs/notes/reveries show \
  "$(git rev-parse 'HEAD:src/state.rs')"

git notes --ref=refs/notes/reveries show \
  "$(git rev-parse ':src/state.rs')"

git notes --ref=refs/notes/reveries show HEAD
git notes --ref=refs/notes/reveries list
git log -p refs/notes/reveries
```

Before authoring a blob reverie, inspect every current path containing that blob:

```bash
blob="$(git rev-parse ':src/state.rs')"
git ls-files -s | awk -v blob="$blob" '$2 == blob && $3 == 0 {
  $1 = $2 = $3 = ""; sub(/^ +/, ""); print
}'
```

## Append a canonical record

Prepare exactly one canonical JSON line, including its final LF. Avoid Git’s default separator and
stripspace behavior:

```bash
printf '%s\n' "$record" > /tmp/reverie-record.jsonl
git notes --ref=refs/notes/reveries append --no-separator --no-stripspace \
  -F /tmp/reverie-record.jsonl "$object"
```

For a new decision, `$object` must be a staged or committed blob. Never use an arbitrary
worktree-only object. Session summaries and initialization records attach to committed objects.

## Search, sync, and publish

```bash
git notes --ref=refs/notes/reveries list |
while read -r note object; do
  if git cat-file blob "$note" | grep -i -- 'transition authority'; then
    printf '%s\n' "$object"
  fi
done

git fetch origin '+refs/notes/reveries*:refs/notes/remotes/origin/reveries*'
git notes --ref=refs/notes/reveries merge -s cat_sort_uniq \
  refs/notes/remotes/origin/reveries
reveries push origin
```

After a manual append or merge, use the helper’s strict check when available before publishing.
Publish with `reveries push <remote>` so the receiver's atomic capability is checked before the
branch and notes refs are requested together. If the helper is unavailable, use the lower-grade
evidence-first sequence: push `refs/notes/reveries` first, then push the code ref separately.
