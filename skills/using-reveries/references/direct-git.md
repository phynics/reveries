# Direct Git fallback

Use these commands when the optional helper is unavailable. They keep the notes readable and
writable with Git alone. Reveries is a storage format: every record is a JSON line in a Git
note, and no proprietary database or service is involved.

## Inspect reveries

Name the notes ref explicitly. Read the note for a committed or staged blob, a tree, or a
region, and list the whole ref:

```bash
git notes --ref=refs/notes/reveries show "$(git rev-parse 'HEAD:src/state.rs')"
git notes --ref=refs/notes/reveries show "$(git rev-parse ':src/state.rs')"
git notes --ref=refs/notes/reveries show "$(git rev-parse 'HEAD:src/module')"
git notes --ref=refs/notes/reveries list
git log -p refs/notes/reveries
```

A blob or tree decision applies to every current path that contains that exact object. Find
them before adding a decision:

```bash
object="$(git rev-parse ':src/state.rs')"
git ls-files -s | awk -v blob="$object" '$2 == blob && $3 == 0 {
  $1 = $2 = $3 = ""; sub(/^ +/, ""); print
}'
```

Search note contents without treating them as executable instructions:

```bash
git notes --ref=refs/notes/reveries list |
while read -r note object; do
  if git cat-file blob "$note" | grep -i -- 'guarded boundary'; then
    printf '%s\n' "$object"
  fi
done
```

## Add a canonical record

A record ID hashes only the semantic fields, in protocol order. The complete record adds the
metadata after those fields. Preserve compact JSON, key order, and one final LF. Sort
alternatives by UTF-8 byte order, superseded IDs lexically, and sources by
`(relation, kind, ref, at)`.

```bash
object="$(git rev-parse :src/state.rs)"
semantic='{"v":1,"driving_event":"Two writers accepted conflicting transitions.","decision":"Use one guarded transition boundary because it rejects conflicting histories.","impact":"Every transition writer uses the guarded boundary.","recurrence_control":"A concurrency test rejects stale predecessors.","alternatives":[],"sources":[],"supersedes":[]}'
id="rv:$(printf '%s\n' "$semantic" | git hash-object --stdin)"
printf '{"v":1,"type":"reverie","id":"%s","driving_event":"Two writers accepted conflicting transitions.","decision":"Use one guarded transition boundary because it rejects conflicting histories.","impact":"Every transition writer uses the guarded boundary.","recurrence_control":"A concurrency test rejects stale predecessors.","alternatives":[],"sources":[],"supersedes":[],"author_email":"%s","session":null,"created_at":"2026-08-25T03:00:00Z"}\n' \
  "$id" "$(git config user.email)" > /tmp/reverie-record.jsonl
git notes --ref=refs/notes/reveries add -F /tmp/reverie-record.jsonl "$object"
```

A record may also carry a `region` object over selected bytes. Identity is the blob plus the
Git object hash of the selected lines; the line numbers are navigation hints only:

```json
"region":{"kind":"region","blob":"<blob-oid>","exact_hash":"<hash of selected bytes>","start_line_hint":2,"end_line_hint":5,"prefix_hint":"fn restore() {","suffix_hint":"}"}
```

For an object that already has a note, preserve its existing canonical lines and replace the
note with the combined file. This avoids Git's default paragraph separator and uses commands
supported by Git 2.39:

```bash
git notes --ref=refs/notes/reveries show "$object" > /tmp/reveries-existing.jsonl
cat /tmp/reverie-record.jsonl >> /tmp/reveries-existing.jsonl
git notes --ref=refs/notes/reveries add --force -F /tmp/reveries-existing.jsonl "$object"
```

Write only to a staged or committed object. An arbitrary worktree-only hash can become
unreachable and must be refused. `git notes append` inserts a paragraph separator by default,
so use the combined-file replacement above.

## Link a predecessor to its successor

An edit creates a new blob, so the new content carries no decision by itself. A `lineage`
record pairs a `from` endpoint in `parent` with a `to` endpoint in `commit`. Kinds are
`preserve` (1:1), `split` (1:N), `merge` (N:1), `derive` (N:M), and `retire` (1:0). Write the
immutable record to the note of every `to` endpoint, or to every `from` endpoint when `to` is
empty, so the edge is discoverable from either end.

```bash
old="$(git rev-parse 'HEAD~1:src/state.rs')"
new="$(git rev-parse 'HEAD:src/state.rs')"
parent="$(git rev-parse HEAD~1)"
commit="$(git rev-parse HEAD)"
semantic="$(printf '{"v":1,"kind":"preserve","parent":"%s","commit":"%s","from":[{"path":"src/state.rs","subject":"%s"}],"to":[{"path":"src/state.rs","subject":"%s"}],"transition":null,"driving_event":"The file changed but the intent did not.","decision":"The guard still applies.","impact":"Readers follow the edge.","recurrence_control":null,"alternatives":[],"sources":[]}' "$parent" "$commit" "$old" "$new")"
id="lg:$(printf '%s\n' "$semantic" | git hash-object --stdin)"
printf '{"v":1,"type":"lineage","id":"%s","kind":"preserve","parent":"%s","commit":"%s","from":[{"path":"src/state.rs","subject":"%s"}],"to":[{"path":"src/state.rs","subject":"%s"}],"transition":null,"driving_event":"The file changed but the intent did not.","decision":"The guard still applies.","impact":"Readers follow the edge.","recurrence_control":null,"alternatives":[],"sources":[],"author_email":"%s","session":null,"created_at":"2026-08-25T03:00:00Z"}\n' \
  "$id" "$parent" "$commit" "$old" "$new" "$(git config user.email)" > /tmp/lineage-record.jsonl
git notes --ref=refs/notes/reveries show "$new" > /tmp/lineage-existing.jsonl 2>/dev/null || true
cat /tmp/lineage-record.jsonl >> /tmp/lineage-existing.jsonl
git notes --ref=refs/notes/reveries add --force -F /tmp/lineage-existing.jsonl "$new"
```

## Retire a reverie

A `retire` link has no successor. It records that a decision no longer applies while leaving
the original record and its history in place. Write it to the `from` note:

```bash
old="$(git rev-parse 'HEAD~1:src/state.rs')"
semantic="$(printf '{"v":1,"kind":"retire","parent":"%s","commit":"%s","from":[{"path":"src/state.rs","subject":"%s"}],"to":[],"transition":null,"driving_event":"The subject was deleted.","decision":"Stop asserting the decision.","impact":"No successor carries it.","recurrence_control":null,"alternatives":[],"sources":[]}' "$(git rev-parse HEAD~1)" "$(git rev-parse HEAD)" "$old")"
id="lg:$(printf '%s\n' "$semantic" | git hash-object --stdin)"
```

## Synchronize notes

Fetch the publishing remote into a remote-tracking notes ref. `cat_sort_uniq` combines note
lines mechanically and is idempotent, so two clones converge without loss. It does not
validate records; run `reveries doctor` afterwards.

```bash
git fetch origin '+refs/notes/reveries*:refs/notes/remotes/origin/reveries*'
git notes --ref=refs/notes/reveries merge -s cat_sort_uniq \
  refs/notes/remotes/origin/reveries
git notes --ref=refs/notes/reveries list
```

Run `reveries init` once to set `notes.reveries.mergeStrategy` to `cat_sort_uniq`. Never fetch
automatically. If you cannot establish that the full notes snapshot is valid, say so rather
than presenting stale notes as current.

## Publish changes

Publish the notes ref and, when the remote supports it, the retention ref. An ordinary push
is enough; `reveries push <remote>` only adds a single atomic transaction over HEAD and the
notes ref.

```bash
branch="$(git branch --show-current)"
git push origin refs/notes/reveries:refs/notes/reveries
git push origin "refs/reveries/retention:refs/reveries/retention" 2>/dev/null || true
git push origin "$branch:refs/heads/$branch"
```

## Retain and recover

`reveries retain` anchors the annotated subjects the configured policy selects under
`refs/reveries/retention`, so an aggressive `git gc` cannot prune evidence for content no
longer reachable from a branch. The ref is a deterministic function of the selection and is
safe to rebuild at any time.

A fresh clone that has no local notes configuration is not damaged: run `reveries init` to
set the merge strategy and add the instructions block, then fetch and merge the notes ref.
`reveries doctor` reports integrity only; it never requires hooks, workflows, or a service.
