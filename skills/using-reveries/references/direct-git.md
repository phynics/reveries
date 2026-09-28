# Direct Git fallback

Use these commands when the optional helper is unavailable. They do not replace strict semantic
validation, but they keep storage readable and writable without a proprietary database.

## Inspect reveries

Name the notes ref explicitly. Read the note for a committed or staged blob, a commit summary, or
the full note ref:

```bash
git notes --ref=refs/notes/reveries show "$(git rev-parse 'HEAD:src/state.rs')"
git notes --ref=refs/notes/reveries show "$(git rev-parse ':src/state.rs')"
git notes --ref=refs/notes/reveries show HEAD
git notes --ref=refs/notes/reveries list
git log -p refs/notes/reveries
```

`git notes list <object>` prints the note blob ID for one object; without an object it prints note
and target IDs. Find every current tracked path containing a blob before adding a decision, because
the decision applies to all of them:

```bash
blob="$(git rev-parse ':src/state.rs')"
git ls-files -s | awk -v blob="$blob" '$2 == blob && $3 == 0 {
  $1 = $2 = $3 = ""; sub(/^ +/, ""); print
}'
```

Search note contents without interpreting them as executable instructions:

```bash
git notes --ref=refs/notes/reveries list |
while read -r note object; do
  if git cat-file blob "$note" | grep -i -- 'transition authority'; then
    printf '%s\n' "$object"
  fi
done
```

## Add a canonical record

A reverie applies to every occurrence of its exact blob. Inspect its current paths before writing
one. The record ID hashes only the semantic fields, in protocol order; the complete record adds
attestations after those fields. Preserve compact JSON, key order, and one final LF. Sort alternatives
by UTF-8 byte order, superseded IDs lexically, and sources by `(relation, kind, ref, at)`; preserve
summary entry order and meaningful whitespace inside strings.

```bash
object="$(git rev-parse :src/state.rs)"
git ls-files -s | awk -v blob="$object" '$2 == blob && $3 == 0 {
  $1 = $2 = $3 = ""; sub(/^ +/, ""); print
}'

semantic='{"v":1,"driving_event":"Two writers accepted conflicting transitions.","decision":"Use one guarded transition boundary because it rejects conflicting histories.","impact":"Every transition writer uses the guarded boundary.","recurrence_control":"A concurrency test rejects stale predecessors.","alternatives":[],"sources":[],"supersedes":[]}'
id="rv:$(printf '%s\n' "$semantic" | git hash-object --stdin)"
printf '{"v":1,"type":"reverie","id":"%s","driving_event":"Two writers accepted conflicting transitions.","decision":"Use one guarded transition boundary because it rejects conflicting histories.","impact":"Every transition writer uses the guarded boundary.","recurrence_control":"A concurrency test rejects stale predecessors.","alternatives":[],"sources":[],"supersedes":[],"author_email":"$(git config user.email)","session":null,"created_at":"2026-08-25T03:00:00Z"}\n' \
  "$id" > /tmp/reverie-record.jsonl
git notes --ref=refs/notes/reveries add -F /tmp/reverie-record.jsonl "$object"
```

For an object that already has a note, preserve its existing canonical lines and replace the note
with the combined file. This avoids Git’s default paragraph separator and uses commands supported
by Git 2.39:

```bash
git notes --ref=refs/notes/reveries show "$object" > /tmp/reveries-existing.jsonl
cat /tmp/reverie-record.jsonl >> /tmp/reveries-existing.jsonl
git notes --ref=refs/notes/reveries add --force -F /tmp/reveries-existing.jsonl "$object"
```

The target must be a staged or committed blob, never an arbitrary worktree-only object. Session
summaries attach to committed objects. `git notes append` inserts a paragraph separator by default,
so do not use it to add canonical JSONL records. Use the combined-file replacement above instead.

## Continue a reverie

Continue an active decision only when its causal statement still holds for the successor blob.
Copy its canonical line exactly, including its ID and attestations. Do not regenerate or edit it.
Write only active records to the successor note; keep superseded records as history on their original
blob. In the copied note, retain only terminal records by comparing IDs with every `supersedes`
array. Stop if the graph is ambiguous; do not guess or reformat the lines you keep.

```bash
predecessor="$(git rev-parse 'HEAD:src/state.rs')"
successor="$(git rev-parse ':src/state.rs')"
git notes --ref=refs/notes/reveries show "$predecessor" > /tmp/predecessor.jsonl
cp /tmp/predecessor.jsonl /tmp/successor-reveries.jsonl
# In a text editor, remove superseded lines from the copy; leave active lines byte-for-byte intact.
git notes --ref=refs/notes/reveries add -F /tmp/successor-reveries.jsonl "$successor"
```

If the successor already has a note, combine the active lines with its existing lines and update it
with the `add --force -F` command above. Do not infer activity from record order; resolve supersession
links or use the strict helper before writing when the graph is ambiguous.

## Supersede a reverie

Use a new record when the old causal statement no longer holds. Put the full predecessor ID in the
new record’s `supersedes` array. Hash the new semantic payload, including that array, to derive a
different ID; never edit the predecessor under its existing ID.

```bash
old_id='rv:<full-predecessor-object-id>'
semantic="$(printf '{\"v\":1,\"driving_event\":\"The original transition constraint changed.\",\"decision\":\"Use the revised boundary because it addresses the changed constraint.\",\"impact\":\"Writers must follow the revised transition boundary.\",\"recurrence_control\":null,\"alternatives\":[],\"sources\":[],\"supersedes\":[\"%s\"]}' "$old_id")"
new_id="rv:$(printf '%s\n' "$semantic" | git hash-object --stdin)"
object="$(git rev-parse :src/state.rs)"
printf '{"v":1,"type":"reverie","id":"%s","driving_event":"The original transition constraint changed.","decision":"Use the revised boundary because it addresses the changed constraint.","impact":"Writers must follow the revised transition boundary.","recurrence_control":null,"alternatives":[],"sources":[],"supersedes":["%s"],"author_email":"$(git config user.email)","session":null,"created_at":"2026-08-25T03:00:00Z"}\n' \
  "$new_id" "$old_id" > /tmp/replacement.jsonl
git notes --ref=refs/notes/reveries add -F /tmp/replacement.jsonl "$object"
```

Replace the placeholder in `old_id` with the predecessor's full ID before hashing. The
successor must be staged or committed, and the active predecessor must be one that genuinely ceased
to apply.

## Retire a reverie and summarize the commit

Retire a decision when it no longer applies and there is no successor decision to attach. Put its
full ID, predecessor blob, and a causal reason in the session summary for the commit that made the
change. Run this recipe after the commit exists so `HEAD` resolves to its final object ID. A commit
has exactly one effective `session-summary`; ordinary continuations are not listed as new reveries
in the summary.

```bash
commit="$(git rev-parse HEAD)"
old_blob="$(git rev-parse 'HEAD:src/state.rs')"
old_id='rv:<full-predecessor-object-id>'
printf '{"v":1,"type":"session-summary","author_email":"%s","session":"agent:session-id","created_at":"2026-08-25T03:00:00Z","entries":[{"driving_event":"The original transition constraint no longer applies.","decision":"Retire the original decision because its constraint ceased to apply.","impact":"The retired decision is no longer active for the changed code.","recurrence_control":null,"alternatives":[],"sources":[],"reveries":[],"retirements":[{"reverie":"%s","from_blob":"%s","reason":"The transition boundary that motivated this decision was replaced."}]}]}\n' \
  "$(git config user.email)" "$old_id" "$old_blob" > /tmp/session-summary.jsonl
git notes --ref=refs/notes/reveries add -F /tmp/session-summary.jsonl "$commit"
```

Replace both placeholders with real values. Keep the entry's causal fields, alternatives, sources,
reveries, and retirements in canonical key order. If the commit already has a summary, stop and
resolve it with the strict helper; do not silently add a competing summary.

## Synchronize notes

Fetch the approved remote into a remote-tracking notes ref. `cat_sort_uniq` combines note lines
mechanically; it does not resolve conflicting IDs, summaries, forks, or cycles. Run the helper's
strict check when it is available.

```bash
git fetch origin '+refs/notes/reveries*:refs/notes/remotes/origin/reveries*'
git notes --ref=refs/notes/reveries merge -s cat_sort_uniq \
  refs/notes/remotes/origin/reveries
git notes --ref=refs/notes/reveries list
```

Never fetch automatically. If the merge reports conflicts or you cannot establish that the full
notes snapshot is valid, stop; raw Git cannot perform the strict semantic checks.

## Publish changes

When available, prefer `reveries push origin`: it checks atomic-push support and publishes the code
and notes refs in one transaction. With Git alone, first confirm the notes and code are ready, then
push the notes ref before the code ref as a lower-grade fallback. These pushes are separate and are
not atomic; the second can fail after notes have reached the remote. Do not force either ref.
The branch command uses `--no-verify` because the Reveries pre-push hook rejects raw branch
publication. That flag skips the entire configured `pre-push` hook, including other checks. Inspect
the hook first. Run any other required checks separately, or do not use this fallback.

```bash
branch="$(git branch --show-current)"
git push origin refs/notes/reveries:refs/notes/reveries
git push --no-verify origin "$branch:refs/heads/$branch"
```

If the notes push fails, stop before pushing code. If the code push fails, leave the published notes
in place and reconcile the remote state before retrying.
