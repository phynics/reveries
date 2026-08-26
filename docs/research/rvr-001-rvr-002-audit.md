# RVR-001 and RVR-002 implementation audit

## Scope

This audit compares the Evidence Graph proposal and the repository ticket specifications with:

- RVR-001 commit `903190fe4aba12d496c18ae97aa7c96623528f1c`;
- RVR-002 commit `9326fe6aaa8ffd6f8e708be127f8690e5a6e16c9`;
- their combined behavior at main commit `003efc7d70d00b96c34ebef61ad09330ef893a7f`.

The review used the implementation, tests, protocol, and Git documentation as primary evidence.
Git documents that `--atomic` either updates every requested ref or none, and that a server can
reject the request when it does not support atomic pushes. Git also documents that `--no-verify`
bypasses the pre-push hook.

## Verdict

RVR-001 implemented the central quarantine-first safety property. It validates a private candidate
before compare-and-swap promotion, leaves the canonical notes ref unchanged on failure, and retains
the union. Its failure result was incomplete because it reduced the conflict to strings.

RVR-002 implemented atomic helper publication and removed managed generic push refspecs. Its local
guard still accepted a raw branch-plus-notes push. Such a push can be non-atomic, so it recreated
the partial-publication risk that RVR-002 was meant to close.

| Item | Result at reviewed commits | Resolution in this branch |
| --- | --- | --- |
| RVR-001 candidate validation before promotion | Pass | No change |
| RVR-001 canonical tip preservation and quarantine | Pass | No change |
| RVR-001 structured conflict output | Fail | Added typed conflict, record lines, origins, provenance, and actions |
| RVR-002 atomic helper publication | Pass | No change |
| RVR-002 raw publication rejection | Fail | Added a helper-only marker and raw branch guard |
| RVR-002 evidence-first fallback instructions | Inconsistent | Documented the explicit second-stage bypass |
| Required summaries on both implementation commits | Missing | Added retrospective summaries to the notes ref |

## Confirmed findings

### Raw multi-ref pushes bypassed the atomic-only path

`GitRepository.pushAtomically` requested `--atomic`, but the pre-push path did not identify who
started the push. `checkOutgoingUpdates` accepted any branch update accompanied by a notes update.
A user could therefore run a raw multi-ref push that passed local validation without requesting an
atomic server transaction.

The fix sets `REVERIES_INTERNAL_ATOMIC_PUSH=1` only for the helper's real atomic push. The
pre-push command rejects every raw branch publication without that marker. A user can still choose
`--no-verify`, which Git defines as an explicit hook bypass.

### Sync failures lost the conflict structure

`SyncResult` returned only `ok`, `state`, and string diagnostics. The proposal also required
the annotated object, canonical records, local and remote provenance, a conflict type, and possible
resolution actions.

The fix returns an `invalid-notes-union` conflict. The result includes the annotated object,
candidate records and their exact canonical lines, local and remote origins, all relevant notes
tips, the quarantine ref, a classified conflict type, and typed resolution actions.

### The documented fallback could not pass the installed hook

The documentation told users to push notes and then run a raw branch push. The second command was
rejected because it omitted a notes update. The corrected fallback uses `--no-verify` for the
second stage and labels that choice as an explicit, lower-grade bypass.

### The implementation commits lacked session summaries

The canonical notes ref had no session summary attached to either RVR implementation commit.
Project policy requires exactly one summary for every post-initialization commit. This branch adds
one retrospective summary to each commit. The notes ref must ship with the branch and the final
merge publication.

## Requirement mapping

### RVR-001

| Requirement | Assessment | Evidence |
| --- | --- | --- |
| Fetch without moving the canonical ref | Pass | `GitRepository.fetchNotes` writes a remote-tracking notes ref |
| Merge into a private candidate | Pass | `mergeFetchedNotes` uses `withNotesWrite` and a transaction ref |
| Validate syntax, IDs, sources, projections, and global invariants | Pass | `strictRead`, `validateSources`, and `validateNotesRef` |
| Promote only after validation with compare-and-swap | Pass | `withNotesWrite` validates before `git update-ref <new> <old>` |
| Preserve an invalid union | Pass | `quarantineNotes` retains the candidate notes commit |
| Return structured conflicts | Fixed here | `SyncConflict` and `describeSyncConflict` |
| Preserve both inputs in the duplicate-summary scenario | Pass | Quarantine acceptance test |
| Provide a complete resolver workflow | Partial | The result identifies the source ref and action, but no resolver command exists |

The quarantine ref uses the candidate OID instead of the proposal's suggested remote-tip OID. The
candidate remains durable and uniquely identified, so this is a naming and provenance deviation,
not a data-loss defect. Validation reads a stable private ref more than once. This is consistent,
but it is not the single indexed snapshot planned for RVR-012.

### RVR-002

| Requirement | Assessment | Evidence |
| --- | --- | --- |
| Remove managed generic push refspecs | Pass | Installer cleanup and integration tests |
| Make `reveries push` the supported publication path | Pass | README and protocol |
| Require atomic support and fail closed | Pass | Atomic dry-run probe and acceptance test |
| Reject raw branch publication | Fixed here | Helper marker, pre-push guard, and CLI regression test |
| Keep atomic rejection all-or-none | Pass | Evidence-ref rejection acceptance test |
| Distinguish local hooks from server authority | Pass with a limit | Doctor reports separate fields, but receive-side state remains unknown |
| Document the evidence-first fallback | Fixed here | The second stage now states its explicit bypass |

`doctor` cannot prove that a hosted repository has enabled a required check or receive hook, so it
reports receive-side protection as `unknown`. Changing that state requires a host adapter or an
explicit verified configuration source. That work belongs to the receive-side enforcement ticket.

## Verification

The new regression tests first reproduced both defects:

- the raw branch-plus-notes pre-push test returned success;
- the quarantine test had no structured conflict result.

After the fixes, the focused CLI and acceptance suites pass. The full test suite, type check,
build, conformance checks, package check, and strict local release evaluation also pass. The staged
and outgoing Reveries checks run after the branch commits are created.

## Sources

- [Git push documentation](https://git-scm.com/docs/git-push)
- [Git hooks documentation](https://git-scm.com/docs/githooks)
- [Git notes documentation](https://git-scm.com/docs/git-notes)
- [Git update-ref documentation](https://git-scm.com/docs/git-update-ref)
- [Repository ticket specifications](../tickets.md)
