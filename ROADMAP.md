# Reveries roadmap

This roadmap records the next architectural direction after V1. Reveries V1 attaches
decisions to exact blobs and attaches a causal summary to each post-adoption commit. The
next version separates engineering causality from commit publication.

## The problem

A commit identity describes a Git object. It includes its tree, parents, author, committer,
timestamps, and message. Amending only metadata creates a new commit even when the engineering
transition is unchanged. Hosted squash merges and merge queues create final commit IDs after
review, so contributors cannot attach evidence to those IDs in advance.

Reveries needs three separate evidence layers:

1. **Object evidence** explains why an exact blob or tree has its form.
2. **Transition evidence** explains why parent tree or trees became a result tree.
3. **Publication attestation** connects a published commit to reviewed transition evidence.

This keeps the causal record stable when publication changes commit metadata. A rebase onto a
different base still requires new transition evidence because its parent tree changes.

## Target architecture

The target V2 model has these parts:

- Git blobs and trees remain the exact subjects of object evidence.
- Git notes remain the native, content-addressed evidence store.
- Immutable facts make replica union deterministic and make conflicts visible.
- Tree-transition summaries become the causal unit for repository-state changes.
- A protected `reveries-ledger` branch carries notes history, manifests, review projections, and
  optional retention checkpoints through normal clone and branch-governance flows.
- A retention vault keeps annotated subjects reachable through Git history.
- Host adapters enforce evidence where hosted systems create merge commits.
- Conformance grades report tested scope without claiming that local tests prove hosted behavior.

V1 remains the current implementation until a ticket introduces an explicit protocol version or
compatibility change. This roadmap does not change the approved V1 design by itself.

## Implementation order

### Stage 1: Make V1 fail safely

Strengthen synchronization, publication, retention, validation cost, worktree detection,
completeness reporting, concurrency, and team-scale testing.

Tickets: [RVR-001](docs/tickets.md#rvr-001-validate-fetched-note-unions-before-promotion),
[RVR-002](https://github.com/phynics/reveries/issues/2),
[RVR-006](https://github.com/phynics/reveries/issues/6),
[RVR-008](https://github.com/phynics/reveries/issues/8),
[RVR-010](https://github.com/phynics/reveries/issues/10),
[RVR-011](https://github.com/phynics/reveries/issues/11),
[RVR-012](https://github.com/phynics/reveries/issues/12),
[RVR-015](https://github.com/phynics/reveries/issues/15),
[RVR-016](https://github.com/phynics/reveries/issues/16), and
[RVR-020](https://github.com/phynics/reveries/issues/20).

### Stage 2: Build the V2 Evidence Graph

Introduce transition summaries, immutable facts, tree decisions, and explicit occurrence and
lineage evidence.

Tickets: [RVR-004](https://github.com/phynics/reveries/issues/4),
[RVR-007](https://github.com/phynics/reveries/issues/7),
[RVR-013](https://github.com/phynics/reveries/issues/13), and
[RVR-014](https://github.com/phynics/reveries/issues/14).

The key invariant is:

> Every protected repository-state transition has one exact causal explanation. Every final
> published commit has an attestation that links it to that transition.

### Stage 3: Add the ledger control plane

Add the protected ledger envelope, receive-side checks, signatures, remote authority roles, and
review surfaces.

Tickets: [RVR-003](https://github.com/phynics/reveries/issues/3),
[RVR-005](https://github.com/phynics/reveries/issues/5),
[RVR-009](https://github.com/phynics/reveries/issues/9),
[RVR-017](https://github.com/phynics/reveries/issues/17), and
[RVR-019](https://github.com/phynics/reveries/issues/19).

The protected `reveries-ledger` envelope branch exists. It carries a canonical manifest
and the exact notes tree grafted at its own object ID, records the notes commit as a
typed parent, and is validated for manifest, tree, parent, and notes-tip mismatches.
Updates are fast-forward and append-only by construction. A checkpoint may now also
carry a `signatures` entry holding signatures over the canonical manifest bytes, which
bind the exact notes, ledger, and retention tips without any new manifest field.

RVR-017 gives the reserved `authority` field its meaning: it names the single primary
remote a checkpoint is published on behalf of. The role vocabulary is `primary`,
`mirror`, `archive`, and `import-only`, declared as `reveries.remoteRole.<remote>` in
configuration and resolved by a pure function, so **the manifest key set and the bytes
RVR-009 signs are unchanged**. A remote with no declared role keeps its pre-RVR-017
behaviour, and absence of authority is a notice rather than damage: a repository with
one publishing remote has an unambiguous source, one with several is unconfigured, and
only a configuration that contradicts itself, such as two declared primaries or a role
for a remote that does not exist, is a diagnostic.

A sync from a non-primary remote runs the identical full-snapshot validation and then has
promotion withheld: the candidate is preserved at
`refs/reveries/quarantine/<remote>/<oid>` and `refs/notes/reveries` is left unchanged.
Promotion is withheld by the write path rather than by caller convention, so an import
or mirror cannot reach canonical state. An `import-only` remote is also refused as a
publication destination, and an `archive` is refused as a synchronization source. A
mirror is verified against the local primary checkpoint rather than trusted by name: it
must declare the same authority, must not transport a notes commit the primary does not
contain, and must sign its own manifest when the primary's checkpoint is signed. The
check is network-free and reads only local remote-tracking refs.

The boundary layer is wired. `reveries role` writes and resolves `reveries.remoteRole.*`,
`reveries policy` writes `reveries.signingRoles`, `reveries trust` creates and manages a
local trust store at `<git-common-dir>/reveries/trust.json` (or `reveries.trustStore`),
and `reveries sign` and `reveries verify` read and write attestations through it. `ledger
build` stamps the resolved primary instead of passing `authority: null`, and a sync reports
a quarantined union as held valid evidence with a notice rather than as a failure. Setup
creates the store atomically and exclusively, so a concurrent setup adopts what is already
there instead of clobbering it and a reader never observes a partial document.

Removal preserves every trust store and deletes no trust material: created, adopted, external,
repointed, or reached through a symlinked parent. It clears only the owned configuration that
is actually set, resolves the store path before clearing it so the report names the store this
repository actually used, and reports the paths it considered. An earlier marker-based deletion
was withdrawn — a path marker is not proof of ownership once a store is repointed, replaced,
re-parented, or adopted from somewhere shared, and a hash to prove the file unchanged would add
lifecycle bookkeeping to a few hundred bytes of public local state. There is no deletion path
and no override flag to request one.

A quarantined remote's ledger envelope is fetched and verified but **not** materialized —
including when an operator names it explicitly, since `ledger materialize` resolves the
remote from the ref it was given and applies the same role rule. The envelope and the notes
ref carry the same evidence, so running the envelope route after the notes route withheld
promotion would hand the decision to whichever transport ran second, and an explicit
materialize would otherwise route straight around the decision the sync made. An invalid
role value fails closed with exit 2 without reaching that route at all.

A contradictory authority configuration now fails `build`, `sync --pull`, and `materialize`
closed, before any checkpoint is written, anything is fetched, or any note moves. `trust
init` rolls back a newly created key when the store write fails, so the retry succeeds and
an existing key is never removed. `trust add` accepts only a PEM public key, normalises it
to SPKI before touching the store, and names the formats it refuses rather than surfacing a
decoder error.

Two boundaries remain open and nothing here is a claim about them. `receive.ts` verifies
the envelope but cannot enforce "only the primary may publish", because it has no notion of
which remote is pushing; and nothing yet refuses a commit or a receive based on signature
trust. The structural form of the envelope guard — `syncPull` owning both routes rather
than the CLI orchestrating them — is core work assigned to the next task.

Federation is **off unless configured**. This change ships the origin-stream ref grammar
(`refs/heads/reveries-origin/<authority-id>`, with a validated single-segment authority
id), the config gate, and stream verification. It does **not** ship a live
multi-authority merge path: consuming an origin stream is RVR-019 or later work. The
order-independent union that criterion requires already exists for the local case in the
RVR-007 fact graph, where unresolved forks refuse promotion.

Signatures exist as a separate, immutable, ID-bearing `signature` record family in
`refs/notes/reveries`, with a `signatures` entry in the ledger tree for the manifest
attestation. A signature commits to the target's canonical bytes by repository object
ID, so `rv:`, `tr:`, `cr:`, `rs:`, and `rd:` identities are unchanged by key rotation:
rotating a key adds a signature, it never edits one. Trust state distinguishes
`unknown`, `valid`, `trusted`, and `policy-satisfying`, and `invalid` and `revoked`
signatures stay visible and reported rather than being removed. Verification runs
through an injectable port with a hermetic in-process ed25519 default and a local
trust store; Git SSH `allowed_signers` is a second implementation behind the same port
and is not implemented yet.

The signing and trust CLI now exists, and a real repository reaches `trusted` and
`policy-satisfying` with the in-process ed25519 backend alone: the SSH backend is an
independent second implementation, not a prerequisite for either state. `trust init` is
the only key-generation path, is exclusive and `0600`, refuses a destination inside the
worktree or either Git directory after resolving the real path, and never reports key
material. Identity is derived from the loaded key's fingerprint rather than typed, so a
key with no trust-store entry is refused. The trust store lives in the Git common
directory, so no clone receives it.

What a signature does **not** cover is now stated rather than implied. Author metadata is
outside both the signed payload and the `sg:` ID, so rewriting a signature record's
`created_at`, `author_email`, or `session` changes neither and leaves the state unchanged.
Those fields are unclaimed provenance, and no CLI output presents them as attested. `key_id`
is likewise outside the payload: a verifier resolves the key by `key_id` while the payload
binds `signer` and `content_id`, and tampering with `content_id` is what the
cryptographic verdict catches.

### Stage 4: Define governance boundaries

Set the policy for secrets, redaction, confidential evidence, hosted compatibility, and recovery
from rewritten or unavailable evidence.

Ticket: [RVR-018](https://github.com/phynics/reveries/issues/18).

## Ticket register

| ID | Priority | Ticket | Feasibility |
| --- | --- | --- | --- |
| RVR-001 | P0 | [Validate fetched-note unions before promotion](docs/tickets.md#rvr-001-validate-fetched-note-unions-before-promotion) | Core / V1 |
| RVR-002 | P0 | [Eliminate unsafe non-atomic publication paths](https://github.com/phynics/reveries/issues/2) | Core / V1 + Boundary |
| RVR-003 | P0 | [Add receive-side and hosted-merge enforcement](https://github.com/phynics/reveries/issues/3) | Core + Adapter + Boundary |
| RVR-004 | P0 | [Introduce tree-transition summaries](https://github.com/phynics/reveries/issues/4) | Core / V2 |
| RVR-005 | P0 | [Introduce a protected ledger envelope branch](https://github.com/phynics/reveries/issues/5) — envelope, manifest, and mismatch validation landed, RVR-009 added the `signatures` tree entry, and RVR-017 gave `authority` its role semantics, so the only remaining item is the RVR-019 `review/` projection | Core / V2 + Adapter |
| RVR-006 | P0 | [Add atomic local commit-and-summary creation](https://github.com/phynics/reveries/issues/6) | Core / V1 |
| RVR-007 | P1 | [Generalize all evidence into a monotonic immutable fact graph](https://github.com/phynics/reveries/issues/7) | Core / V2 |
| RVR-008 | P0 | [Preserve annotated objects against garbage collection](https://github.com/phynics/reveries/issues/8) | Core / V1 |
| RVR-009 | P1 | [Add cryptographic attestations and signed checkpoints](https://github.com/phynics/reveries/issues/9) — the `signature` record family, the trust vocabulary, key rotation that preserves decision IDs, signed ledger checkpoints, the signing/trust CLI, and the `install.ts` trust-store setup all landed, and a real repository now reaches `trusted` and `policy-satisfying` with the in-process ed25519 backend alone. The Git SSH `allowed_signers` verifier and boundary acceptance of a signature remain | Core / V2 + Boundary |
| RVR-010 | P0 | [Add protocol resource limits and bounded validation](https://github.com/phynics/reveries/issues/10) | Core / V1 hardening |
| RVR-011 | P0 | [Detect unstaged worktree edits correctly](https://github.com/phynics/reveries/issues/11) | Core / V1 |
| RVR-012 | P1 | [Replace repeated scans with a snapshot loader and disposable index](https://github.com/phynics/reveries/issues/12) | Core / V1 |
| RVR-013 | P1 | [Support exact tree-level engineering decisions](https://github.com/phynics/reveries/issues/13) | Core / V2 |
| RVR-014 | P1 | [Add occurrence-specific and N-to-M lineage evidence](https://github.com/phynics/reveries/issues/14) | Core / V2 |
| RVR-015 | P1 | [Model shallow and partial-clone completeness explicitly](https://github.com/phynics/reveries/issues/15) | Core / V1 |
| RVR-016 | P0 | [Remove the crash-prone lock as a correctness dependency](https://github.com/phynics/reveries/issues/16) | Core / V1 |
| RVR-017 | P1 | [Define primary authority, mirrors, and optional federation](https://github.com/phynics/reveries/issues/17) — roles, exactly-one-primary resolution, import quarantine, mirror verification, the `reveries role` writer, the `ledger build` authority stamp, and the envelope guard that keeps a quarantined remote out of canonical state all landed, with federation shipping as an off-by-default grammar and gate rather than a live merge path | Core / V1 and V2 |
| RVR-018 | P1 | [Define redaction, secrets, and confidential-evidence policy](https://github.com/phynics/reveries/issues/18) | Partial / Boundary |
| RVR-019 | P1 | [Add evidence-diff review surfaces for PRs and IDEs](https://github.com/phynics/reveries/issues/19) | Core + Adapter |
| RVR-020 | P0 | [Add multi-user, failure, and scale conformance grades](https://github.com/phynics/reveries/issues/20) | Core + Adapter |

## Conformance policy

The project reports separate grades:

- **LOCAL** covers the current protocol, CLI, direct-Git, installer, and single-repository
  behavior.
- **TEAM** covers multiple writers and clones, failure recovery, retention, incomplete clones,
  resource limits, fuzzing, and published scale results.
- **HOSTED** names the host, version, merge methods, required checks, and recovery behavior.
- **AUTOMATIC DELIVERY** names the agent host and version tested by native delivery fixtures.

A higher grade is never inferred from a lower grade. Each grade needs executable criteria and
evidence for the exact environment it names.

## Policy boundary

Reveries evidence must be readable by everyone authorized to read the repository. It must never
contain secrets. Soft redaction can suppress normal display, but it cannot erase bytes from clones,
bundles, mirrors, or caches. Hard redaction must state that distributed deletion is not guaranteed.
