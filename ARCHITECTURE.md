# Reveries V1 implementation shape

## Problem

Reveries must enforce byte-level JSONL rules, causal decision continuity, and Git notes publication without making its helper authoritative. The hard part is the boundary between pure protocol rules and mutable Git state. If command handlers each coordinate parsing, validation, object resolution, and notes writes, those invariants will drift.

## Usage from the caller's view

The CLI completes whole operations:

```bash
reveries show src/state.rs --staged --json
reveries record new src/state.rs --from reverie.json
reveries check --staged
reveries summarize HEAD --from summary.json
reveries sync --pull origin
reveries push origin
```

The library keeps protocol work independent from Git:

```ts
const parsed = parseNote(noteText, "tolerant");
const strict = validateNote(parsed);
const projection = projectActiveReveries(strict.reveries);
```

Host adapters translate native events into `HookEvent` and pass them to one shared hook handler. Receive adapters translate proposed refs and hosted events into the same receive-check contract; neither adapter parses notes or decides continuity.

## Shape

The package has four modules grouped by the knowledge they own:

- `protocol` owns record types, canonical JSONL, semantic IDs, strict and tolerant parsing, source syntax, and active projection.
- `git` owns argv-based Git execution, object resolution, notes transactions, tree and history facts, remotes, and the common-directory lock.
- `operations` owns complete user actions such as record, summarize, check, receive-check, search, sync, push, doctor, and initialization. Receive checks reuse these operations against a proposed notes snapshot opened from a bare repository.
- `cli` and `hooks` parse external inputs and render typed outcomes.

External JSON, CLI arguments, Git output, and host events are `unknown` until their boundary parser returns domain values. Blob IDs, commit IDs, object IDs, and reverie IDs use separate branded types. Protocol functions do not import process, filesystem, or child-process modules.

Every notes mutation acquires `<git-common-dir>/reveries/write.lock`, snapshots `refs/notes/reveries`, writes through a temporary notes ref, validates the result, and updates the canonical ref with the old tip as a compare-and-swap guard. This protects linked worktrees and detects writers that bypass the helper.

The public interface is small because each operation hides canonicalization, validation, Git resolution, and mutation ordering. Callers provide intent and receive a typed result with exit code `0`, `1`, `2`, or `3`.

## Synthesis decision

Both independent candidates chose a pure protocol core and an argv-based Git adapter. The implementation uses Terra's package layout and explicit capability grading. It uses Luna's temporary-notes-ref transaction because that design can detect an out-of-lock notes update before publication. A generic controller, service, and repository stack was rejected because it would expose internal stages and repeat protocol state across shallow interfaces.

## Tradeoffs accepted

- We accept explicit protocol serializers in exchange for byte-exact output that does not depend on a generic canonical-JSON package.
- We accept real temporary Git repositories in integration tests in exchange for testing Git's actual notes, hash format, rename, and worktree behavior.
- We accept `CORE` or `UNVERIFIED` adapter grades until host-specific conformance tests support a stronger claim.
- We accept raw notes scans in V1 in exchange for keeping the disposable search index out of the first correctness boundary.

## Alternatives considered

- A repository-centric service object lost because command code would need to understand Git state transitions and protocol validation stages.
- One module per execution step lost because `load`, `validate`, `transform`, and `save` would all expose the same record representation.
- Direct writes to the canonical notes ref lost because a helper cannot compare the expected old tip after another writer bypasses its lock.

## Open questions and risks

- Which host and version can support a verified automatic-delivery grade after fixture tests are complete?
- Which hook managers can the initializer recognize without guessing at their composition rules?
- How much rename information can the outgoing checker derive safely before it must require `--successor`?

## Next implementation step

Build byte-exact protocol vectors and their failing tests before implementing canonicalization.
