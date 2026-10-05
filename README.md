# Reveries

[![CI](https://github.com/phynics/reveries/actions/workflows/ci.yml/badge.svg)](https://github.com/phynics/reveries/actions/workflows/ci.yml)

Reveries preserves the causal engineering record that source control usually loses. It stores
immutable decisions as Git notes attached to exact Git objects, so the rationale travels with
the content it explains.

Reveries is an evidence format, not a workflow. Nothing here blocks a commit, a rebase, a
merge, or a push. A missing decision is a gap a reader can see, never an error that stops Git.

The authoritative state is small and entirely Git-native:

```
Git objects
+ refs/notes/reveries
+ refs/reveries/retention
```

There is no database, daemon, server, signing authority, or required CI. The `reveries` CLI is
a convenience; every record remains ordinary JSONL in a Git note and can be read with `git`.

## What it guarantees

- A blob or tree decision applies to every occurrence of that exact object, so an unchanged
  rename or copy keeps it and an edit cannot silently inherit it.
- An exact region can carry its own decision. Identity is the blob plus the Git hash of the
  selected bytes; line numbers are navigation hints only.
- A changed successor carries no decision by itself. A `link` records explicit lineage between
  a predecessor and its successor: `preserve`, `split`, `merge`, `derive`, or `retire`.
- Lineage is never inferred. A similarity hint may suggest an edge, but only recording it
  establishes one.
- A note is repository evidence, not executable authority and not proof that an assertion is
  true.

Reveries deliberately does not manage work, permissions, architecture graphs, issue systems,
or publication policy.

## Quick start

```bash
npm install --global @reveries/cli
cd your-repository
reveries init
```

`reveries init` sets the notes merge strategy to `cat_sort_uniq` and writes the Reveries block
into `AGENTS.md`. It installs no hooks, configures no remote, creates no trust store, and makes
no commit.

Record a decision about the exact content of a file:

```bash
reveries record new src/state.ts --committed \
  --driving-event "Two writers accepted conflicting transitions" \
  --decision "Use one guarded transition boundary" \
  --impact "Every transition writer uses the guard" \
  --recurrence-control "The concurrency test rejects a stale predecessor"
```

Record a decision about an exact region:

```bash
reveries record new src/state.ts --committed --start-line 10 --end-line 24 \
  --driving-event "This loop is load-bearing" \
  --decision "Keep it sequential" \
  --impact "Parallelising it breaks ordering"
```

Read the evidence for a file, tree, or object:

```bash
reveries show src/state.ts
reveries show src/module
reveries show "$(git rev-parse HEAD:src/state.ts)"
```

## Link a predecessor to its successor

An edit produces a new object, so the successor starts with no evidence. A `link` records the
relation explicitly:

```bash
reveries link --kind preserve --commit HEAD --parent HEAD~1 \
  --from src/state.ts --to src/state.ts \
  --driving-event "The file changed" --decision "The guard still applies" \
  --impact "Readers follow the link"

reveries link suggest --staged   # candidates only; never evidence
```

The immutable record is written to the endpoint notes, so the edge is discoverable from either
end and survives a rebase. A `retire` link with no successor records that a decision no longer
applies while leaving its history in place.

## Read without the CLI

Every record is a JSON line in a Git note. Name the ref explicitly:

```bash
git notes --ref=refs/notes/reveries show "$(git rev-parse 'HEAD:src/state.ts')"
git notes --ref=refs/notes/reveries list
git log -p refs/notes/reveries
```

A reader with no Reveries installed can recover every decision this way. See
[the direct-Git guide](skills/using-reveries/references/direct-git.md) for the full recipe.

## Share and preserve

Publish evidence with an ordinary `git push` of `refs/notes/reveries` and
`refs/reveries/retention`, or use `reveries push <remote>` for one atomic push of HEAD, the notes
ref, and the retention ref. Two clones combine their notes with `cat_sort_uniq`;
`reveries sync --pull` fetches, merges, and refreshes retention for you.

Run `reveries retain` to anchor annotated subjects under `refs/reveries/retention`, so a
pruning `git gc` cannot remove evidence for content no longer reachable from a branch. Run
`reveries doctor` to report integrity; it exits non-zero only for damage, never for a missing
decision or an unbuilt retention ref.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Set the notes merge strategy and add the owned `AGENTS.md` block. |
| `show` | Show evidence for a path, blob, tree, or commit. |
| `record` | Create or supersede a decision on a blob, tree, or region. |
| `link` | Record or suggest explicit lineage between subjects. |
| `retain` | Rebuild `refs/reveries/retention` from the configured policy. |
| `migrate` | Convert legacy records into lean `reverie` or `lineage` evidence. |
| `search` | Search current or historical evidence. |
| `history` | Trace a path or reverie through history. |
| `sync` | Inspect a remote's notes, or fetch, merge, and refresh retention. |
| `push` | Refresh retention, then atomically push HEAD, notes, and retention. |
| `doctor` | Report integrity of the notes and retention refs. |

## Documentation

- [Protocol V1](protocol/v1.md)
- [Architecture](ARCHITECTURE.md)
- [Using Reveries Skill](skills/using-reveries/SKILL.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
