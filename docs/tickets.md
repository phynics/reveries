# Reveries ticket specifications

These specifications turn the Evidence Graph proposal into implementation tickets. Each ticket names the current architecture it touches, the result it must produce, a method that keeps the work testable, its dependencies, and acceptance criteria.

## RVR-001: Validate fetched-note unions before promotion

**Priority:** P0
**Feasibility:** Core / V1
**Stage:** 1
**Tracker:** Repository specification. Implemented by [PR #21](https://github.com/phynics/reveries/pull/21).

### Problem

`mergeFetchedNotes` can merge two valid notes refs and promote the result before validation checks the union. The union can contain two session summaries for one commit, multiple initialization boundaries, or invalid source relationships.

### Architecture

`operations.ts` owns the quarantine-first sync flow. `protocol.ts` validates records and global invariants. `projection.ts` computes active decisions and visible conflicts. `git.ts` creates private refs, reads candidate objects, and performs the final compare-and-swap. `cli.ts` renders structured conflict diagnostics.

### Goal

Keep `refs/notes/reveries` valid. If a fetched union is invalid, leave the canonical ref unchanged and preserve the candidate for diagnosis and later resolution.

### Method

1. Fetch the remote notes tip without moving the canonical local ref.
2. Merge local and remote notes into a private candidate ref.
3. Load one complete candidate snapshot.
4. Validate syntax, semantic IDs, source links, projections, initialization state, and conflict heads.
5. Promote the candidate with an expected-old-OID compare-and-swap only after validation passes.
6. Store rejected candidates at `refs/reveries/quarantine/<remote>/<remote-notes-oid>`.
7. Return the affected object, record IDs, provenance, conflict type, and resolution options.

### Dependencies

Reuse the existing temporary notes-ref transaction and notes validator. RVR-012 can replace repeated scans later, but this ticket must work with the current loader.

### Acceptance criteria

- A valid local ref and valid remote ref whose union has two summaries for one commit make `sync --pull` fail.
- The canonical notes tip remains unchanged.
- The invalid candidate remains in quarantine.
- No input record is discarded.
- A resolver can later build and validate a replacement candidate.
- Tests cover global conflicts, stale candidates, retries, and quarantine cleanup.

## RVR-002: Eliminate unsafe non-atomic publication paths

**Priority:** P0
**Feasibility:** Core / V1 plus Boundary
**Stage:** 1
**Tracker:** [GitHub issue #2](https://github.com/phynics/reveries/issues/2). Implemented by [PR #22](https://github.com/phynics/reveries/pull/22).

### Problem

Generic multi-ref pushes can move the code ref while rejecting `refs/notes/reveries`. Only the helper requests atomic push.

### Architecture

The publication path crosses `operations.ts` and `git.ts`. Installation and diagnostics live in `install.ts`. The pre-push hook prevents local accidents. A receive hook or hosted check supplies server authority and remains outside the core package.

### Goal

Ensure that the supported V1 publication command never leaves published code without matching evidence. Make the boundary between helper behavior, local accident prevention, and server enforcement visible.

### Method

Remove generic `remote.<name>.push` entries. Make `reveries push` require `git push --atomic`. Fail closed when the server does not support atomic push. Mark helper-owned Git invocations so the pre-push hook can reject accidental adopted-branch publication. Have `doctor` report helper publication, local protection, and receive-side enforcement separately. Document evidence-first two-stage push as a lower-grade fallback for non-atomic servers.

### Dependencies

RVR-001 defines safe notes promotion. RVR-003 adds receive-side enforcement where local protection is not enough.

### Acceptance criteria

- Initialization no longer presents raw `git push` as safe.
- A rejected atomic push advances neither ref.
- The helper cannot publish code when the evidence update is rejected.
- `doctor` distinguishes helper, local, and receive-side protection.
- Documentation says that local hooks are not a security boundary.
- Tests reject either ref and verify that both refs stay unchanged.

## RVR-003: Add receive-side and hosted-merge enforcement

**Priority:** P0
**Feasibility:** Core checker, Adapter integrations, Boundary guarantee
**Stage:** 3
**Tracker:** [GitHub issue #3](https://github.com/phynics/reveries/issues/3)

### Problem

Local hooks cannot enforce evidence for hosted squash merges, rebase merges, or merge queues. Those systems create or select final commits on the server.

### Architecture

Add a host-neutral receive checker beside the core operations. It consumes proposed object IDs and calls protocol validation, transition lookup, completeness checks, and policy checks. A GHES adapter invokes it from a pre-receive hook. A GitHub adapter runs it for `pull_request` and `merge_group`. A V1 merge bot remains an optional compatibility adapter.

### Goal

Validate a proposed code and evidence update before the host moves refs. The check must not depend on a worktree or on a final commit ID that does not exist yet.

### Method

Implement `reveries receive-check --old-code <oid> --new-code <oid> --old-evidence <oid> --new-evidence <oid> --policy <file>`. Validate ancestry, new records, transition evidence, required attestations, semantic forks, resource limits, and signer requirements. Make the GitHub check use the merge queue candidate base.

### Dependencies

RVR-004 supplies transition identity. RVR-005 supplies the protected evidence branch. RVR-009 supplies signer policy. RVR-019 supplies the review projection.

### Acceptance criteria

- A pure receive fixture validates proposed ref updates.
- GHES rejects code without evidence before refs move.
- GitHub runs the check on both `pull_request` and `merge_group`.
- A base-tree change invalidates an earlier check.
- The required status check is pinned to the installed App.
- Fork pull requests have an explicit evidence-import workflow.

## RVR-004: Introduce tree-transition summaries

**Priority:** P0
**Feasibility:** Core / V2
**Stage:** 2
**Tracker:** [GitHub issue #4](https://github.com/phynics/reveries/issues/4)

### Problem

Commit IDs change during amends, squashes, and hosted merges even when the engineering transition is unchanged. A rebase can apply similar text to a different base.

### Architecture

Extend protocol records with `transition-summary` and `publication-attestation`. `protocol.ts` owns canonical transition identity. `git.ts` resolves ordered parent trees and result trees. `operations.ts` computes candidate transitions for commit, receive, and merge-group commands. `projection.ts` links a publication attestation to the applicable transition.

### Goal

Make the exact state transition the causal identity. A final commit attestation records who published it and which reviewed transition it used.

### Method

Define transition identity as ordered parent-tree IDs, result-tree ID, and canonical causal fields. Store the record on the result tree or in the ledger indexed by that identity. Use `git merge-tree --write-tree` for candidate merges before creating a final commit.

### Dependencies

RVR-006 provides the local plumbing path. RVR-007 generalizes immutable facts. RVR-005 and RVR-003 consume the transition record for hosted publication.

### Acceptance criteria

- A metadata-only amend reuses the transition.
- A rebase onto changed content requires new or adapted evidence.
- Merge parent order is preserved.
- Root commits use an empty parent-tree list.
- Squash and merge-group fixtures validate before a final commit ID exists.
- V1 summaries remain readable and can be projected when both tree sides are known.

## RVR-005: Introduce a protected ledger envelope branch

**Priority:** P0
**Feasibility:** Core / V2 plus Adapter
**Stage:** 3
**Tracker:** [GitHub issue #5](https://github.com/phynics/reveries/issues/5)

### Problem

Custom notes refs are not fetched by normal clones and are weakly represented by hosted branch governance. That makes discovery, review, and policy enforcement harder.

### Architecture

Add `refs/heads/reveries-ledger` as a transport and governance layer. Its tree contains `manifest.json`, a `notes/` subtree, and a generated `review/` projection. Its parents identify the previous ledger checkpoint, the exact ordinary notes commit, and an optional retention checkpoint. `refs/notes/reveries` remains the native object-evidence interface.

### Goal

Make evidence reachable through ordinary branch fetches without duplicating note blobs or replacing Git notes as the native storage format.

### Method

Define and validate the manifest, parent roles, notes-tree OID, retention tip, counts, size statistics, signer policy, previous checkpoint, and related transitions. Make sync materialize the local notes ref only after checking the envelope. Require fast-forward ledger updates and append-only semantics.

### Dependencies

RVR-008 supplies retention. RVR-009 supplies signed checkpoints. RVR-017 defines authority roles. RVR-019 can consume the review subtree.

### Acceptance criteria

- A normal clone receives the ledger branch.
- The notes parent is present without a custom notes-ref fetch.
- Materialized notes work with `git notes`.
- Ledger updates are fast-forward and append-only.
- Manifest, parent, and subtree mismatches are rejected.
- V1 notes history imports without rewriting.
- Ledger additions cannot remove existing facts.

## RVR-006: Add atomic local commit-and-summary creation

**Priority:** P0
**Feasibility:** Core / V1
**Stage:** 1
**Tracker:** [GitHub issue #6](https://github.com/phynics/reveries/issues/6)

### Problem

The post-commit hook runs after the branch moves. It can report a missing summary, but it cannot make commit creation and summary creation one operation.

### Architecture

Add the command in `operations.ts`. Use `git.ts` for `write-tree`, `commit-tree`, temporary notes refs, and `update-ref --stdin`. Keep message parsing in `cli.ts` and reuse existing protocol validation. Run host notifications only after publication succeeds.

### Goal

Create one commit and one valid summary with a guarded writer transaction. A failed preparation or stale expected OID must move neither the branch nor the notes ref.

### Method

Check staged continuity. Write the result tree. Prepare and validate the commit message. Create the commit object without moving the branch. Build and validate the candidate notes tip. Update branch and notes refs with expected old OIDs in one transaction. Notify hooks after success. Preserve message hooks, signing, merge parents, amend behavior, and author and committer metadata.

### Dependencies

RVR-002 defines safe publication. RVR-004 later changes the causal record used by the command.

### Acceptance criteria

- A stale branch or notes OID moves neither ref.
- A successful command creates exactly one summary.
- Merge commits preserve every parent.
- Signing and message-hook fixtures pass.
- Interruption before publication leaves no blocking lock or partial branch update.

## RVR-007: Generalize all evidence into a monotonic immutable fact graph

**Priority:** P1
**Feasibility:** Core / V2
**Stage:** 2
**Tracker:** [GitHub issue #7](https://github.com/phynics/reveries/issues/7)

### Problem

Blob reveries use immutable semantic IDs and supersession. Session summaries use replacement. Concurrent corrections can therefore create invalid unions instead of an explicit fork.

### Architecture

Extend the protocol record union and projection code. `protocol.ts` defines immutable facts and IDs. `projection.ts` computes active facts and conflicts. `operations.ts` appends corrections and resolutions. `git.ts` stores the union without rewriting earlier lines.

### Goal

Make all authoritative evidence mergeable as a typed grow-only set. A conflict stays visible until a new resolution fact names every conflicting head.

### Method

Give decisions, transitions, dispositions, publication attestations, initialization facts, corrections, redactions, and signatures immutable semantic IDs. Define union as associative, commutative, and idempotent. Define active state as a deterministic projection. Never use timestamps as a winner.

### Dependencies

RVR-004 supplies transition facts. RVR-009 and RVR-018 add signatures and redactions. RVR-001 can later use the fact union instead of rejecting every semantic fork.

### Acceptance criteria

- Merge order does not change the fact set.
- Concurrent corrections produce a deterministic visible fork.
- A resolution naming both heads produces one active result.
- Earlier records remain directly inspectable.
- No operation rewrites an old canonical line.
- Projection tests cover forks, cycles, duplicate attestations, and multi-head resolution.

## RVR-008: Preserve annotated objects against garbage collection

**Priority:** P0
**Feasibility:** Core / V1
**Stage:** 1
**Tracker:** [GitHub issue #8](https://github.com/phynics/reveries/issues/8)

### Problem

A notes tree stores subject object IDs as text. That text does not keep the blobs, trees, or commits reachable. Garbage collection can prune the object that the evidence explains.

### Architecture

Add retention-ref creation and inspection in `git.ts` and `operations.ts`. Keep retention policy in repository configuration and report coverage through `doctor`. The future ledger stores the current retention checkpoint as a typed parent.

### Goal

Make retention explicit and keep selected annotated subjects reachable without copying their content.

### Method

Use a fanout tree at `refs/reveries/retention/objects` for blobs and trees. Use a braided commit-parent chain for annotated commits. Support `none`, `active`, `all`, and `archive`. Make vault rebuild deterministic from evidence. Include notes, ledger, and retention refs in bundles.

### Dependencies

RVR-012 provides efficient evidence loading. RVR-005 carries the vault checkpoint in the ledger. RVR-018 defines what hard redaction does to retention.

### Acceptance criteria

- Unretained control objects can be pruned.
- Retained annotated objects survive aggressive pruning.
- The vault rebuilds deterministically from evidence.
- Retention removal requires an explicit policy.
- Bundles include notes, ledger, and retention refs.
- `doctor` reports missing subjects and coverage.

## RVR-009: Add cryptographic attestations and signed checkpoints

**Priority:** P1
**Feasibility:** Core / V2 records and checkpoints; Boundary identity enforcement
**Stage:** 3
**Tracker:** [GitHub issue #9](https://github.com/phynics/reveries/issues/9)

### Problem

Email addresses, timestamps, and session IDs do not prove identity. The notes ref can also be rewritten without an external policy.

### Architecture

Keep signatures as separate protocol facts. `protocol.ts` canonicalizes the signed payload. `operations.ts` creates and verifies attestations. `git.ts` reads signed commits or tags for checkpoint verification. Host adapters provide allowed-signers and branch-policy inputs.

### Goal

Allow independent author, reviewer, and publisher attestations without changing semantic decision IDs when keys rotate.

### Method

Sign the protocol domain, record or transition ID, subject, canonical record bytes, signer identity, algorithm, and signature. Add signed ledger checkpoints that bind the exact notes, ledger, and retention tips. Report unknown, valid, trusted, and policy-satisfying states separately.

### Dependencies

RVR-004 defines transition IDs. RVR-005 defines the checkpoint envelope. RVR-017 defines authority roles.

### Acceptance criteria

- Multiple signatures can attest one semantic record.
- Invalid and revoked signatures remain visible and are reported.
- A checkpoint binds exact notes, ledger, and retention tips.
- Key rotation does not change decision IDs.
- Trust state distinguishes unknown, valid, trusted, and policy-satisfying signatures.

## RVR-010: Add protocol resource limits and bounded validation

**Priority:** P0
**Feasibility:** Core / V1 hardening
**Stage:** 1
**Tracker:** [GitHub issue #10](https://github.com/phynics/reveries/issues/10)

### Problem

The protocol does not bound note size, record size, narrative fields, arrays, graph traversal, or diagnostic count. Notes are untrusted input.

### Architecture

Define limits in protocol documentation and schemas. Enforce them in `protocol.ts` before expensive projection. Enforce object-size checks and batch reads in `git.ts`. Expose lower deployment budgets through command policy. Add malformed-input vectors to protocol and integration tests.

### Goal

Give every validation path deterministic memory, work, and diagnostic ceilings without making valid existing records needlessly fragile.

### Method

Benchmark an initial profile before freezing normative ceilings. Read object size before body content. Parse one bounded JSONL line at a time. Reuse one `git cat-file --batch-command` process. Build indexes once per snapshot. Cap graph traversal and diagnostics. Fuzz malformed JSON, Unicode, deep graphs, and oversized fields.

### Dependencies

RVR-012 supplies the snapshot loader. RVR-007 adds graph projection that needs explicit depth limits.

### Acceptance criteria

- Oversized notes are rejected before body loading.
- One malformed record cannot create unbounded diagnostics.
- Validation has deterministic memory and work ceilings.
- Limits appear in schemas and protocol vectors.
- Existing fixtures remain valid or report migration diagnostics.

## RVR-011: Detect unstaged worktree edits correctly

**Priority:** P0
**Feasibility:** Core / V1
**Stage:** 1
**Tracker:** [GitHub issue #11](https://github.com/phynics/reveries/issues/11)

### Problem

The hook resolves the edited path from the index. An unstaged edit leaves the index unchanged, so the hook can miss the change.

### Architecture

Keep event translation in `hooks.ts` and host adapters. Change worktree observation in the hook state machine. Keep successor blob resolution in the staged `operations.ts` path and `continuity.ts`.

### Goal

Tell the user when an annotated worktree file changed, even when the index still contains the predecessor. Do not make the reminder depend on a staged successor.

### Method

Capture path type, raw worktree fingerprint, `HEAD` and index blobs, and active decision IDs before the edit. After the edit, use `git diff-files --quiet -- <path>` or an equivalent fingerprint. Emit a reminder for a real change. Resolve the authoritative successor only in `check --staged`.

### Dependencies

Reuse `createHookState`, `handleHookEvent`, and `analyzeContinuity`. RVR-012 is not required for this behavior.

### Acceptance criteria

- Real repository tests cover unstaged edits.
- A changed worktree with an unchanged index emits a reminder.
- No-op edits emit nothing.
- Staged checks use the exact staged blob.
- Deletion, symlink, rename, multiple paths, and filtered paths have explicit behavior.

## RVR-012: Replace repeated scans with a snapshot loader and disposable index

**Priority:** P1
**Feasibility:** Core / V1
**Stage:** 1
**Tracker:** [GitHub issue #12](https://github.com/phynics/reveries/issues/12)

### Problem

Search and validation repeatedly scan notes and invoke Git. The cost can become quadratic as the evidence corpus grows.

### Architecture

Add an `EvidenceSnapshot` owned by the protocol and operations boundary. `git.ts` supplies one notes-tree traversal and one persistent `cat-file --batch-command` process. The optional SQLite index lives under the Git common directory and remains disposable.

### Goal

Parse each note once per evidence tip and let validation, projection, search, and backlinks use shared indexes without changing authoritative behavior.

### Method

Load the notes tip, object-to-record map, record-ID map, attestations, source backlinks, active projections, initialization state, and diagnostics in one pass. Key the optional SQLite index by the exact notes or ledger tip. Update it by diffing notes trees. Rebuild it after corruption or deletion.

### Dependencies

RVR-010 supplies work limits. RVR-001, RVR-015, and RVR-019 consume the snapshot. SQLite must not become a protocol dependency.

### Acceptance criteria

- Each note is parsed at most once per snapshot.
- Source validation uses an ID map.
- Deleting the database changes no authoritative behavior.
- Corruption triggers a rebuild without evidence loss.
- Benchmarks publish memory and latency for 10,000 and 100,000 records.

## RVR-013: Support exact tree-level engineering decisions

**Priority:** P1
**Feasibility:** Core / V2
**Stage:** 2
**Tracker:** [GitHub issue #13](https://github.com/phynics/reveries/issues/13)

### Problem

Blobs are too narrow for some module and directory decisions, while repository summaries are too broad. Git trees provide exact immutable subtree identity.

### Architecture

Extend the protocol subject type from `blob` to `blob | tree`. Extend `git.ts` object resolution and tree traversal. Extend `continuity.ts`, search, and projections to resolve every current path that reaches a tree subject.

### Goal

Record why an exact subtree has its file composition while preserving the current rule that identical content carries universal evidence.

### Method

Validate tree-scoped records strictly. Resolve explicit predecessor and successor tree objects. Treat similarity detection as a user-facing suggestion. Require a continuity disposition when a descendant edit produces a new ancestor tree.

### Dependencies

RVR-004 defines tree transition identity. RVR-012 provides efficient path and object lookup. RVR-014 handles cases where universal tree applicability is false.

### Acceptance criteria

- Tree notes are strictly validated as tree evidence.
- Unchanged subtree moves and copies retain applicability.
- Descendant edits create continuity obligations.
- Search shows current paths resolving to a tree.
- Recording discloses universal tree applicability.

## RVR-014: Add occurrence-specific and N-to-M lineage evidence

**Priority:** P1
**Feasibility:** Core / V2
**Stage:** 2
**Tracker:** [GitHub issue #14](https://github.com/phynics/reveries/issues/14)

### Problem

One blob can occur in vendored, fixture, and production paths with different rationale. File continuity also cannot represent splits, merges, extraction, or symbol changes.

### Architecture

Keep universal blob evidence in the core protocol. Add occurrence and lineage records only when a caller opts in. Keep path-history logic in operations and let language adapters propose symbol relationships without turning the core into a general architecture graph.

### Goal

Represent where a decision remains applicable when content identity alone is too broad. Preserve simple universal records for the common case.

### Method

Define occurrences by commit, path, and blob or tree object. Define explicit lineage edges for preserve, split, merge, derive, and retire. Give each edge a transition and causal reason. Treat Git similarity and AST matching as suggestions that require explicit confirmation.

### Dependencies

RVR-013 adds tree subjects. RVR-004 supplies the transition link. RVR-007 supplies immutable lineage facts.

### Acceptance criteria

- Two occurrences of one blob can carry different occurrence-specific evidence.
- Split, merge, derive, and retire transitions are representable.
- Similarity detection never becomes silent authority.
- Path history follows explicit rename-plus-edit lineage.
- Existing universal blob records remain unchanged.

## RVR-015: Model shallow and partial-clone completeness explicitly

**Priority:** P1
**Feasibility:** Core / V1
**Stage:** 1
**Tracker:** [GitHub issue #15](https://github.com/phynics/reveries/issues/15)

### Problem

Missing objects can mean no evidence, stale notes, shallow history, missing promisor objects, disabled lazy fetch, or pruning. Treating every case as absence creates false negatives.

### Architecture

Add completeness to typed operation results and JSON output. `git.ts` detects shallow and promisor state without fetching. `hooks.ts` disables lazy fetch for automatic delivery. `operations.ts` exposes explicit offline, fetch, and require-complete choices.

### Goal

Never turn an incomplete local view into a claim that evidence does not exist.

### Method

Use grades such as `complete`, `notes-unfetched`, `notes-stale`, `shallow-boundary`, `promisor-object-missing`, `subject-pruned`, and `unknown`. Set `GIT_NO_LAZY_FETCH` or the equivalent option for automatic hooks. Keep network access explicit in user commands and report the reason in machine-readable output.

### Dependencies

RVR-008 supplies retention coverage. RVR-012 supplies snapshot-tip freshness. RVR-020 records partial-clone results in conformance evidence.

### Acceptance criteria

- Automatic hooks make no lazy fetch.
- Shallow absence differs from authoritative absence.
- Online commands require deliberate permission.
- Partial-clone fixtures verify no-network behavior.
- Search reports its completeness grade.

## RVR-016: Remove the crash-prone lock as a correctness dependency

**Priority:** P0
**Feasibility:** Core / V1
**Stage:** 1
**Tracker:** [GitHub issue #16](https://github.com/phynics/reveries/issues/16)

### Problem

The directory lock can remain after a killed process or machine crash. Compare-and-swap already protects canonical publication, so the directory lock should not be the correctness boundary.

### Architecture

Keep ref update and temporary-ref handling in `git.ts`. Move retry and replay policy into the notes mutation operation. Keep any optional lease diagnostic and non-authoritative. `doctor` reports abandoned temporary refs and contention.

### Goal

Make process death leave disposable objects instead of a repository-wide write blockage. Preserve record safety when linked worktrees write concurrently.

### Method

Read the canonical notes tip. Build and validate a mutation on a unique private ref. Attempt an expected-old-OID update. On contention, replay the pure mutation against the new tip and retry with bounded backoff. Return explicit bounded-contention failure.

### Dependencies

RVR-001 defines candidate validation. RVR-012 reduces reload cost during retries. RVR-006 uses the same guarded update primitive.

### Acceptance criteria

- Killing a writer cannot block later writes.
- Concurrent linked-worktree writers lose no records.
- Twenty appenders converge or return bounded-contention failure.
- Temporary refs are collectible and diagnosable.
- CAS remains the final publication guard.

## RVR-017: Define primary authority, mirrors, and optional federation

**Priority:** P1
**Feasibility:** Core / V1 roles and V2 federation; organizational authority is Boundary
**Stage:** 3
**Tracker:** [GitHub issue #17](https://github.com/phynics/reveries/issues/17)

### Problem

Multiple publishing remotes lack a clear primary authority. Peer-merging independently writable notes refs can create split-brain publication and confusing provenance.

### Architecture

Extend initialization records and remote configuration in `install.ts` and `operations.ts`. Keep canonical notes in the current ref for V1. Use ledger checkpoints and signed origin streams for V2. `doctor` validates authority configuration.

### Goal

Make the source of authoritative publication explicit while preserving mirror, archive, and offline import workflows.

### Method

Add `primary`, `mirror`, `archive`, and `import-only` roles. Require exactly one primary. Merge only the primary into canonical state. Keep imports in quarantine. For V2 federation, give each authority an append-only signed stream at `refs/heads/reveries-origin/<authority-id>` and compute a deterministic union without timestamp winner selection.

### Dependencies

RVR-005 defines checkpoints. RVR-009 defines signer trust. RVR-001 defines quarantine behavior.

### Acceptance criteria

- Exactly one primary is required.
- Mirrors match a signed primary checkpoint.
- Import-only evidence cannot enter canonical state silently.
- Federation preserves each origin history.
- Union and conflicts do not depend on processing order.

## RVR-018: Define redaction, secrets, and confidential-evidence policy

**Priority:** P1
**Feasibility:** Prevention and tooling are feasible; global erasure is Boundary
**Stage:** 4
**Tracker:** [GitHub issue #18](https://github.com/phynics/reveries/issues/18)

### Problem

Evidence can contain credentials, customer data, security details, or regulated information. Rewriting a remote ref cannot erase bytes from existing clones, bundles, mirrors, or caches.

### Architecture

Put the public evidence policy in `README.md`, protocol docs, and initialization guidance. Add pre-write checks at CLI and operation boundaries. Represent soft redaction as an immutable protocol fact. Put hard-redaction history rewriting and retention rebuilds in an explicit maintenance command. Keep confidential pointers separate from public records.

### Goal

Prevent secrets from entering evidence and describe redaction without claiming that distributed Git history can be erased everywhere.

### Method

Scan new narrative fields for secrets, high-entropy values, pasted logs, and personal data. Enforce size limits. Add signed soft-redaction facts that suppress normal projections while preserving a non-sensitive reason. Add hard-redaction tooling that creates a signed discontinuity checkpoint and mirror action report. Support only signed opaque pointers for confidential rationale.

### Dependencies

RVR-007 supplies immutable redaction facts. RVR-008 supplies retention rebuilds. RVR-009 supplies signatures. RVR-010 supplies field limits.

### Acceptance criteria

- Documentation prohibits secrets.
- Soft-redacted records do not render in normal delivery or search.
- Hard redaction creates a verifiable checkpoint and mirror report.
- No command claims to erase independent clones.
- Confidential pointers are syntactically distinct from public evidence.

## RVR-019: Add evidence-diff review surfaces for PRs and IDEs

**Priority:** P1
**Feasibility:** Core diff engine and Adapter presentation
**Stage:** 3
**Tracker:** [GitHub issue #19](https://github.com/phynics/reveries/issues/19)

### Problem

Raw JSONL and command-line search are insufficient for routine review. Reviewers need evidence changes beside code changes.

### Architecture

Add a host-neutral diff operation in `operations.ts` and stable JSON rendering in `cli.ts`. Reuse protocol projections and the snapshot loader. Keep GitHub checks and IDE views as read-only adapters. Generated review files are projections and never authority.

### Goal

Let a reviewer see what causal evidence changed, what remains unresolved, and which transition the candidate uses without reading raw note bodies.

### Method

Implement `reveries diff <base>..<candidate> --json`. Include new, continued, superseded, and retired decisions; transitions; unresolved obligations; signatures and trust; completeness; and evidence that does not apply to the candidate. Render the same JSON into GitHub checks and later IDE hover or CodeLens views.

### Dependencies

RVR-004 supplies transitions. RVR-009 supplies trust state. RVR-012 supplies snapshots. RVR-015 supplies completeness. RVR-003 consumes the output for hosted checks.

### Acceptance criteria

- One JSON diff drives CLI, CI, and adapters.
- Merge-group checks use actual candidate trees.
- Rendering has deterministic size limits.
- Read-only adapters do not mutate evidence.
- Reviewers can see causal changes without reading JSONL.

## RVR-020: Add multi-user, failure, and scale conformance grades

**Priority:** P0
**Feasibility:** Core test infrastructure plus hosted Adapter fixtures
**Stage:** 1
**Tracker:** [GitHub issue #20](https://github.com/phynics/reveries/issues/20)

### Problem

The current release gate covers local behavior but not multi-user operation, hosted Git behavior, or verified automatic delivery. A passing local suite must not imply team or hosted readiness.

### Architecture

Extend `scripts/evaluate-local.mjs`, `scripts/conformance.mjs`, direct-Git acceptance, installer acceptance, and native-skill evidence into independent grade runners. Store named host, agent, repository size, record count, memory, latency, and failure evidence as test artifacts.

### Goal

Report readiness as a matrix with independent evidence. Prevent a local pass from implying team, hosted, or automatic-delivery claims.

### Method

Define four grades. `LOCAL` covers current protocol, CLI, direct-Git, installer, and single-repository checks. `TEAM` covers multiple clones and writers, invalid unions, CAS retries, push failures, force-push and deleted-branch cases, garbage collection, shallow and partial clones, termination, fuzzing, limits, and performance. `HOSTED` names the host and version, pull request type, fork behavior, merge method, merge queue, required checks, permissions, transport failures, and recovery. `AUTOMATIC DELIVERY` names the agent host and version and records native delivery evidence. Report a matrix instead of one `release_ready` boolean.

### Dependencies

RVR-001, RVR-002, RVR-008, RVR-010, RVR-012, RVR-015, and RVR-016 provide Stage 1 behavior to measure. RVR-003 and RVR-005 provide hosted fixtures.

### Acceptance criteria

- Every grade has named executable criteria.
- No higher grade is inferred from a lower one.
- Scale results publish repository size, record count, memory, and latency.
- Hosted results name exact host versions and merge modes.
- A multi-user pilot is required for stable `TEAM` status.
