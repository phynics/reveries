# Contributing

Reveries is a Git evidence format, not a workflow. Contributions keep the authoritative state
small: Git objects, `refs/notes/reveries`, and `refs/reveries/retention`. Nothing in the
repository should gate a commit, a push, or a merge.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm run test:full
npm run verify          # build + typecheck + full test + 25 PRD acceptance criteria
```

`npm run verify` is the release gate. It runs `scripts/direct-git-acceptance.mjs`, which drives
the 25 PRD acceptance criteria against the built CLI and raw Git in disposable repositories.
`scripts/evaluate-local.mjs` maps every criterion to its passing step. CI runs the same gate on
Node 22 and, in a container, on Git 2.39.

## Design rules

- Keep the authoritative state to the three items above. A new ref, file, or service is a
  design change that needs a reason.
- No module may decide when a commit, a push, or a merge is allowed. `doctor` reports integrity
  and exits non-zero only for damage.
- Evidence attaches to an object, never to a path. A path is navigation and a source, never
  applicability.
- A reader must skip unknown record types without interpreting or rejecting them, so a lean
  clone tolerates bytes written by another version.
- Keep `reverie` and `lineage` IDs byte-stable. A change to the canonical payload is a protocol
  change.

## Record a decision

Before changing annotated code, inspect the evidence on the exact object:

```bash
reveries show path/to/file
git notes --ref=refs/notes/reveries show "$(git rev-parse 'HEAD:path/to/file')"
```

When you change an annotated object, decide explicitly whether the prior decision continues, is
superseded, or is retired. An edit produces a new object, so the successor carries no evidence
until you link it:

```bash
reveries link --kind preserve --commit HEAD --parent HEAD~1 \
  --from path/to/file --to path/to/file \
  --driving-event "..." --decision "..." --impact "..."
```

A `retire` link with no successor records that a decision no longer applies. See
[the direct-Git guide](skills/using-reveries/references/direct-git.md) for the raw recipes.

## Publish

Publish evidence with an ordinary `git push` of `refs/notes/reveries`, or use
`reveries push <remote>` for one atomic push of HEAD and the notes ref. Two clones combine
notes with `cat_sort_uniq`; run `reveries init` once to set it. Run `reveries retain` to anchor
annotated objects under `refs/reveries/retention`.

## Commit messages

Use the repository's conventional prefixes (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`)
and explain the engineering reason. A commit does not need a session summary.
