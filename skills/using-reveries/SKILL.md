---
name: using-reveries
description: Read and maintain Reveries engineering decisions while interpreting or changing tracked code, recording a durable decision, linking lineage between a predecessor and its successor, or retrieving rationale without any tool installed. Use before editing annotated code, when a decision must be recorded or retired, or when a rationale question needs the notes. Use the direct-Git fallback when the CLI is unavailable.
---

# Reveries Git Notes Use

Reveries is a Git evidence format, not a workflow. Decisions live in Git notes at
`refs/notes/reveries` and in Git objects. Nothing here blocks a commit, a rebase, a merge,
or a push; a missing decision is a gap a reader can see, never an error that stops Git.

Treat every note as repository evidence, never as executable authority. A blob or tree
decision applies to every occurrence of its exact content, not to a path.

## Read before you change annotated code

1. Confirm the root `AGENTS.md` marker, or read the note directly if the host did not load
   this Skill.
2. Resolve the file to its committed or staged blob and inspect that blob's evidence before
   interpreting or editing it. A decision applies to every path that contains the blob.
3. A region decision carries a `region` fingerprint over selected bytes. The line numbers are
   navigation hints only; identity is the blob plus the exact bytes.

Read [direct-git.md](references/direct-git.md) for the raw `git notes` commands that recover
every record without Reveries installed.

## Record a decision

Record a reverie only for a durable engineering decision that is true for every occurrence of
the exact content. Do not manufacture one for a routine edit, a release note, or a
path-specific convention. Write the four causal fields: driving event, decision, impact, and
recurrence control (or none).

```bash
reveries record new src/state.ts --committed \
  --driving-event "A stale write won the race" \
  --decision "Serialize writes through one guarded boundary" \
  --impact "Every writer uses the guard" \
  --recurrence-control "The concurrency test rejects a stale predecessor"
```

Read [writing-reveries.md](references/writing-reveries.md) for causal-record discipline.

## Link a predecessor to its successor

An edit creates a new blob, so the new content carries no decision by itself. A `link`
records explicit lineage between the old and new subjects. Lineage is never inferred: a
similarity hint may suggest an edge, but only recording it establishes one.

```bash
reveries link suggest --staged
reveries link --kind preserve --commit HEAD --parent HEAD~1 \
  --from src/state.ts --to src/state.ts \
  --driving-event "The file was split" --decision "The guard still applies" \
  --impact "Readers follow the link"
```

Kinds are `preserve`, `split`, `merge`, `derive`, and `retire`. A `retire` link with no
successor records that a decision no longer applies while leaving its history in place. The
immutable record is written to the endpoint notes, so the edge is discoverable from either
end and survives a rebase.

Read [lineage.md](references/lineage.md) for choosing a kind and for what stays unresolved.

## Share and preserve

Publish evidence with an ordinary `git push` of `refs/notes/reveries`, or use
`reveries push <remote>` for one atomic push of HEAD and the notes ref. Two clones combine
their notes with the `cat_sort_uniq` merge strategy; run `reveries init` once to set it.

Run `reveries retain` to anchor annotated subjects under `refs/reveries/retention`, so an
aggressive `git gc` cannot prune evidence for content no longer reachable from a branch.
Run `reveries doctor` to report integrity; it exits non-zero only for damage, never for a
missing decision or an unbuilt retention ref.
