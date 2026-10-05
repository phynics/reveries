# Reveries implementation shape

## Problem

Reveries must preserve byte-level JSONL rules, content-addressed applicability, and Git notes
publication without making its helper authoritative. The hard part is the boundary between
pure protocol rules and mutable Git state. If command handlers each coordinate parsing,
validation, object resolution, and notes writes, those invariants drift.

Reveries is subtractive: the smaller the authoritative surface, the easier it is to prove.
Everything that decided when a commit or a push was allowed has been removed.

## Authoritative state

```
Git objects            blobs, trees, and commits; evidence targets
refs/notes/reveries    one JSONL record set per annotated object
refs/reveries/retention  anchors annotated objects against a pruning gc
```

No other ref, file, database, or service is authoritative. A reader with no Reveries installed
can recover every decision with `git notes`.

## Shape

The package has four modules grouped by the knowledge they own:

- `protocol` owns record types, canonical JSONL, semantic IDs, strict and tolerant parsing,
  source syntax, region fingerprints, lineage, and active projection. Unknown record types are
  skipped, never rejected, so a lean reader tolerates bytes written by another version.
- `git` owns argv-based Git execution, object resolution, notes transactions, notes merge,
  retention, and remotes.
- `operations` owns the user actions: `show`, `record`, `link`, `sync`, `retain`, `push`, and
  `doctor`. `search` and `history` are read-only companions.
- `cli` parses arguments and renders typed outcomes. It holds no protocol logic.

External JSON, CLI arguments, and Git output are `unknown` until their boundary parser returns
domain values. Object IDs and reverie IDs use branded types. Protocol functions do not import
process, filesystem, or child-process modules.

Every notes mutation reads `refs/notes/reveries`, applies the change through a unique temporary
ref under `refs/notes/reveries-txn/`, validates the result, and updates the canonical ref with
the old tip as a compare-and-swap guard, retrying with bounded backoff on contention. This
protects linked worktrees and never lets a killed writer block future writes.

## Why content addressing

A decision attaches to an object, not a path. An unchanged rename or copy keeps the decision; an
edit produces a new object and inherits nothing. A region narrows a blob to exact bytes without
weakening universal applicability, because the fingerprint is derived from the bytes, not the
line numbers.

## Why explicit lineage

An edit leaves a successor with no evidence. A `link` records `preserve`, `split`, `merge`,
`derive`, or `retire` between endpoint objects, so the edge survives a rebase. Lineage is never
inferred: a similarity hint may suggest an edge, but only recording it establishes one. An edge
carries no decision, so it cannot become a back door around per-decision reasoning.

## What was removed

The ledger envelope, signing and trust, authority and roles, redaction, transitions and
attestations, corrections and resolutions, occurrences, session summaries, the adoption
boundary, the receive gate, hosted workflows, merge bots, and host adapters. Each of them
decided when a commit, a push, or a merge was allowed. That decision belongs to the operator and
to ordinary Git, not to an evidence store.

## Legacy bytes and migration

A record type this build does not know is preserved bytes, not damage. The ref-wide read and
write path skips it, so an earlier version's evidence never blocks a mutation, a notes merge, or
`doctor`; `doctor` counts it as a notice. `reveries migrate` converts the legacy records whose
subject is unambiguous into lean `reverie` or `lineage` evidence and reports the rest, without
deleting any bytes.

## Tradeoffs accepted

- We accept explicit protocol serializers in exchange for byte-exact output.
- We accept real temporary Git repositories in integration tests in exchange for testing Git's
  actual notes, hash format, rename, and worktree behavior.
- We accept raw notes scans in exchange for keeping a disposable search index out of the
  correctness boundary.
- We accept that a clone can hold evidence for an older version's record types; it keeps the
  bytes and reports them without interpreting them.
