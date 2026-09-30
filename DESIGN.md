# Reveries: Git-Notes Engineering Memory

**Status:** Approved V1 design
**Implementation status:** Implemented in commit `c14b10b`
**Protocol:** `reveries/v1`
**Canonical notes ref:** `refs/notes/reveries`
**Primary storage:** Git notes attached to blobs and commits
**Supported agent hosts:** Pi, Claude Code, OpenCode, Codex, Gemini CLI
**Skills:**

* `reveries-git-notes-init`
* `using-reveries`
* `reveries-git-notes-search`

---

## 1. Purpose

Reveries preserves engineering decisions beside the immutable Git content they explain.

Source code normally preserves **what** exists. It frequently fails to preserve **why** that implementation was selected, what event or constraint drove it, which alternatives were rejected, what consequences the choice creates, and how recurrence of the original problem is controlled.

A **reverie** is a durable record of a decision made about a file. It provides the engineering "why" for the file's Git "what."

The central V1 promise is:

> Reveries attaches causal engineering decisions to exact file blobs, makes those decisions discoverable when the file is read, and prevents an annotated file from changing without every prior decision being explicitly continued, superseded, or retired.

Reveries also attaches one session summary to every newly published commit after repository initialization. The summary records what the commit accomplished and why the engineering change was made.

Git notes are suitable for this because they can annotate Git objects without modifying those objects, live in a separately versioned ref, and support line-oriented merge strategies. Every notes update itself creates a Git commit in the notes ref. ([Git SCM][1])

---

## 2. Product boundary

Reveries V1 is an engineering-memory system, not a complete repository control plane.

It does:

* preserve file-level engineering decisions;
* attach decisions to immutable Git blobs;
* record a causal session summary for every new commit;
* carry source provenance;
* detect unreconciled decisions after file changes;
* search current and historical engineering rationale;
* deliver relevant reveries when agents read files;
* synchronize the engineering record through a Git notes ref;
* keep the storage understandable without a proprietary database.

It does not:

* manage tasks;
* allocate work to agents;
* enforce filesystem permissions;
* maintain a dependency or ownership graph;
* execute tests;
* define an executable specification language;
* prove that a decision is correct;
* infer all decisions from transcripts;
* replace ADRs;
* replace commit messages;
* provide path-level or directory-level identity;
* create semantic architecture graphs;
* resolve issue trackers or email systems over the network;
* prove that a source reference truly caused a decision;
* provide mandatory server-side enforcement in V1.

A commit must have an engineering explanation. A commit does **not** have to invent a new file reverie.

---

## 3. Design principles

### 3.1 Blob identity is authoritative

A file reverie is attached to a Git blob.

That means:

* an unchanged rename retains the same reveries;
* an unchanged copy resolves the same reveries;
* byte-identical files share the same reveries;
* reusing an old blob later also restores the same reveries;
* a file edit produces a new blob and therefore does not silently inherit the old decisions.

There is no path applicability metadata in V1.

A decision that applies only because of a pathname, architectural location, module role, deployment location, or ownership boundary cannot be represented as a V1 file reverie unless it is true for every occurrence of that blob.

Paths may be cited as historical sources, but paths do not determine applicability.

### 3.2 Engineering causality, not changelog prose

This is invalid:

> The state machine was removed.

It only records what happened.

This is valid:

> Remove the parallel state machine because its ownership model is incompatible with `rs-concurrent-state`, which requires mutation to remain inside a single guarded state boundary.

A useful reverie must allow a future engineer to answer:

* What condition drove this decision?
* What was selected?
* Why was that choice selected?
* What does the decision affect?
* How is recurrence prevented or detected?
* What would be endangered by casually reversing it?

### 3.3 Decisions are immutable

A reverie's semantic identity derives from its causal content.

A reverie is never edited under the same identifier.

Corrections produce a new reverie that supersedes the inaccurate one.

### 3.4 Notes are evidence, not authority

A reverie records what an engineer or agent concluded. It does not prove that the conclusion is correct.

Structured source links are attributable claims. They are not automatic proof of causality.

### 3.5 The script is optional

Core read, write, fetch, merge, search, and push operations remain possible with Git and ordinary text-processing tools.

The optional helper provides:

* canonical serialization;
* ID generation;
* continuity analysis;
* friendly rendering;
* search indexing;
* hook adaptation;
* installation and diagnosis;
* merge-conflict analysis.

The Git notes ref is authoritative. The helper is replaceable.

---

## 4. Domain model

### Reverie

An immutable causal engineering decision associated with a Git blob.

### Session summary

The accountable engineering account attached to a commit.

A session summary explains the commit's driving event, decision, impact, and recurrence control. It may describe several distinct engineering changes through multiple entries.

### Initialization record

A record attached to the repository's Reveries adoption commit. It establishes the protocol version and the historical boundary after which commit summaries are required.

### Subject object

The Git object carrying a note:

* blob for a reverie;
* commit for a session summary;
* commit for the initialization record.

### Driving event

The concrete condition that required or materially favored a decision.

Examples include:

* an observed defect;
* an incident;
* a user directive;
* a compatibility constraint;
* an external requirement;
* a measurement;
* a prior design;
* an unacceptable risk;
* a conflict between system models.

### Decision

The selected engineering disposition and why it addresses the driving event.

### Impact

The consequences and scope of the decision beyond the immediate edit.

Impact may include:

* architectural constraints;
* interface changes;
* compatibility changes;
* accepted disadvantages;
* migration requirements;
* affected callers;
* operational consequences;
* newly introduced risks;
* retired risks.

### Recurrence control

How the driving event is prevented, detected, or shown to remain controlled.

It may name:

* a test;
* a static check;
* a structural invariant;
* an operational monitor;
* a review requirement;
* an explicit guard;
* a deliberate absence of a current control.

NASA lessons-learned records commonly distinguish the driving event, learned conclusion, recommendation, and recurrence-control evidence. NASA systems-engineering guidance separately stresses impact evaluation, traceability, configuration control, and verification. Reveries condenses those ideas into four fields appropriate for day-to-day software engineering. ([Llis][2])

### Source

A durable address identifying something that contributed to a decision.

### Continuity disposition

The treatment of an old reverie when its blob changes:

* continue;
* supersede;
* retire.

---

## 5. Storage architecture

All records live in one ref:

```text
refs/notes/reveries
```

The same ref stores:

* blob notes containing reverie records;
* commit notes containing session summaries;
* the initialization record.

Git notes can annotate objects other than commits, and `git notes --ref=<ref>` allows an explicit custom notes namespace. The design never changes `core.notesRef`; every command names the Reveries ref explicitly. ([Git SCM][1])

### 5.1 Notes as JSONL sets

A note body is a UTF-8 JSONL document.

Each physical line is one canonical JSON object.

The note is semantically an unordered set of records.

Example blob note:

```json
{"v":1,"type":"reverie","id":"rv:8a7b...","driving_event":"...","decision":"...","impact":"...","recurrence_control":null,"alternatives":[],"sources":[],"supersedes":[],"author_email":"engineer@example.com","session":"codex:019...","created_at":"2026-08-25T03:00:00Z"}
{"v":1,"type":"reverie","id":"rv:b621...","driving_event":"...","decision":"...","impact":"...","recurrence_control":"...","alternatives":["..."],"sources":[{"relation":"caused-by","kind":"issue","ref":"github:org/repo#417"}],"supersedes":[],"author_email":"engineer@example.com","session":"claude:abc...","created_at":"2026-08-25T03:20:00Z"}
```

The `cat_sort_uniq` notes merge strategy concatenates, sorts, and deduplicates physical lines, which makes it a natural mechanical merge for canonical one-record-per-line notes. Semantic conflicts remain the responsibility of the strict reader. ([Git SCM][1])

### 5.2 Record universe

V1 has exactly three protocol record types:

```text
reverie
session-summary
reveries-init
```

There are no V1 records for:

* attachment;
* retirement;
* incident;
* directive;
* warning;
* task;
* experiment;
* verification;
* path scope;
* generic evidence.

Retirement is represented inside a session-summary entry.

Incidents, directives, users, issues, commits, blobs, paths, and prior reveries are represented as sources.

---

## 6. Canonical reverie schema

```json
{
  "v": 1,
  "type": "reverie",
  "id": "rv:<full-git-object-id>",
  "driving_event": "Concrete condition that required or materially favored this decision.",
  "decision": "Selected engineering action and why it addresses the driving event.",
  "impact": "Consequences, constraints, risks, interfaces, or future obligations created by the decision.",
  "recurrence_control": "How the original condition is prevented or detected, or null.",
  "alternatives": [
    "Meaningful rejected alternative"
  ],
  "sources": [
    {
      "relation": "caused-by",
      "kind": "issue",
      "ref": "github:owner/repository#417"
    }
  ],
  "supersedes": [],
  "author_email": "engineer@example.com",
  "session": "codex:thread-id",
  "created_at": "2026-08-25T03:00:00Z"
}
```

### 6.1 Required fields

Every field is required except that `session` may be `null`.

```text
v
type
id
driving_event
decision
impact
recurrence_control
alternatives
sources
supersedes
author_email
session
created_at
```

### 6.2 Field rules

`v`

* integer;
* exactly `1`.

`type`

* exactly `"reverie"`.

`id`

* exactly the semantic ID derived under the algorithm below.

`driving_event`

* nonempty string;
* identifies the actual forcing condition;
* not a task description such as "refactor state handling."

`decision`

* nonempty string;
* includes both what was selected and why it addresses the driving event.

`impact`

* nonempty string;
* records consequences beyond the changed lines.

`recurrence_control`

* string or `null`;
* `null` means no recurrence control is established;
* placeholders such as `"N/A"`, `"none"`, and `"tests pass"` are not acceptable substitutes.

`alternatives`

* array of strings;
* may be empty;
* includes only meaningful rejected alternatives.

`sources`

* array of typed source objects;
* may be empty.

`supersedes`

* array of full reverie IDs;
* may be empty.

`author_email`

* required Git email identity;
* normally defaults from `git config user.email`.

`session`

* host session identity or `null`.

`created_at`

* canonical UTC RFC 3339 timestamp.

### 6.3 Example

```json
{
  "v": 1,
  "type": "reverie",
  "id": "rv:f118d877e39a30bd...",
  "driving_event": "The existing state machine and rs-concurrent-state independently own transition validity. Concurrent writers can therefore create a history accepted by one model and rejected by the other.",
  "decision": "Remove the parallel state machine and route every transition through rs-concurrent-state because one guarded mutation boundary must be the sole authority for transition validity.",
  "impact": "All transition writers must use rs-concurrent-state. Reintroducing another transition owner would reopen the original concurrency defect, and stored legacy states require migration.",
  "recurrence_control": "The focused concurrency suite exercises stale-predecessor rejection, and a source check confirms that no transition writes remain outside the guarded boundary.",
  "alternatives": [
    "Adapt the existing state machine behind a compatibility layer",
    "Keep both transition models and reconcile after writes"
  ],
  "sources": [
    {
      "relation": "caused-by",
      "kind": "issue",
      "ref": "github:owner/repository#417"
    },
    {
      "relation": "constrained-by",
      "kind": "git-email",
      "ref": "user@example.com"
    }
  ],
  "supersedes": [],
  "author_email": "engineer@example.com",
  "session": "codex:019b7d...",
  "created_at": "2026-08-25T03:00:00Z"
}
```

---

## 7. Reverie identity

A reverie ID is content-derived.

It is calculated from a canonical semantic payload containing only:

```text
v
driving_event
decision
impact
recurrence_control
alternatives
sources
supersedes
```

It excludes:

```text
type
id
author_email
session
created_at
annotated blob
commit
path
```

The semantic payload is serialized canonically, terminated by one LF, and hashed using the repository's Git object algorithm:

```bash
semantic='{"v":1,"driving_event":"...","decision":"...","impact":"...","recurrence_control":null,"alternatives":[],"sources":[],"supersedes":[]}'
oid="$(printf '%s\n' "$semantic" | git hash-object --stdin)"
id="rv:$oid"
```

This works in both SHA-1 and SHA-256 repositories because Git selects the repository's object format.

### 7.1 Consequences

The same semantic decision receives the same reverie ID.

Continuing a decision onto a successor blob preserves the ID.

Changing any causal content creates a new ID.

A corrected decision must therefore supersede the old ID.

### 7.2 Duplicate IDs

Same ID, same semantic payload:

* semantically one reverie;
* duplicate physical records may collapse;
* differing author metadata may be retained as multiple attestations by tolerant readers;
* strict projection treats the semantic decision once.

Same ID, different semantic payload:

* corruption;
* strict operations refuse.

---

## 8. Canonical session-summary schema

Every post-initialization commit has exactly one effective session-summary record.

```json
{
  "v": 1,
  "type": "session-summary",
  "author_email": "engineer@example.com",
  "session": "codex:thread-id",
  "created_at": "2026-08-25T03:05:00Z",
  "entries": [
    {
      "driving_event": "Two incompatible mechanisms independently owned transition validity.",
      "decision": "Remove the parallel state machine because rs-concurrent-state must become the sole transition authority.",
      "impact": "Every transition writer now uses the guarded state boundary, and legacy persisted states require migration.",
      "recurrence_control": "The concurrency suite covers stale-predecessor rejection.",
      "alternatives": [
        "Retain both mechanisms behind a compatibility adapter"
      ],
      "sources": [
        {
          "relation": "caused-by",
          "kind": "issue",
          "ref": "github:owner/repository#417"
        }
      ],
      "reveries": [
        "rv:f118d877e39a30bd..."
      ],
      "retirements": []
    }
  ]
}
```

### 8.1 Summary identity

A session summary has no independent `ss-*` ID.

The annotated commit is its identity.

A source reference to a session summary uses the commit OID:

```json
{
  "relation": "derived-from",
  "kind": "commit",
  "ref": "<full-commit-oid>"
}
```

### 8.2 Entries

`entries` is a nonempty array.

Most commits should contain one entry.

A commit that contains several genuinely distinct engineering changes uses several entries rather than one vague umbrella explanation.

### 8.3 Entry fields

Each entry contains:

```text
driving_event
decision
impact
recurrence_control
alternatives
sources
reveries
retirements
```

`reveries` includes:

* newly introduced reveries;
* reveries that materially supersede older decisions.

It does not list ordinary continuations.

### 8.4 Retirements

Retirement is expressed only in a session-summary entry:

```json
{
  "reverie": "rv:<old-id>",
  "from_blob": "<full-blob-oid>",
  "reason": "The abstraction no longer exists because transition ownership moved entirely into rs-concurrent-state."
}
```

A retirement reason must be causal and specific.

This is invalid:

```text
No longer needed.
```

This is valid:

```text
The decision no longer applies because the queue abstraction was removed and deduplication ownership moved into the database transaction boundary.
```

### 8.5 Merge commits

Merge commits require a session summary.

The summary explains:

* which engineering histories were integrated;
* why the merge is being published;
* how competing decisions were reconciled;
* what consequences follow from the integrated result.

### 8.6 Automated commits

Automation uses a session identity such as:

```json
"session": "automation:dependency-update"
```

The summary remains causal. "Automated update" is not by itself an adequate decision.

### 8.7 Summary corrections

A summary may be corrected:

```json
"correction_reason": "The original summary omitted the compatibility constraint."
```

The helper rewrites the current commit note so that exactly one effective summary remains.

The notes ref's own Git history preserves the prior summary.

Concurrent histories that produce two distinct summaries on one commit form a strict conflict.

---

## 9. Initialization record

The Reveries adoption commit contains:

1. one session summary;
2. one `reveries-init` record.

```json
{
  "v": 1,
  "type": "reveries-init",
  "protocol": 1,
  "notes_ref": "refs/notes/reveries",
  "publishing_remotes": [
    "origin"
  ],
  "hosts": [
    "pi",
    "claude",
    "opencode",
    "codex",
    "gemini"
  ],
  "author_email": "engineer@example.com",
  "created_at": "2026-08-25T03:05:00Z"
}
```

`publishing_remotes` and `hosts` are historical installation facts. They do not override current local configuration.

The initialization record establishes:

* protocol v1;
* canonical notes ref;
* the adoption boundary.

The initializer does not create the commit unless explicitly requested. It prepares tracked changes and prints the commands needed to annotate the resulting commit.

---

## 10. Canonical serialization

Authoritative notes use these byte-level rules:

1. UTF-8.
2. No byte-order mark.
3. One JSON object per physical line.
4. No insignificant whitespace.
5. One LF after every record.
6. No literal control bytes.
7. JSON keys appear in protocol-defined order.
8. String outer whitespace is trimmed.
9. Internal string whitespace is preserved.
10. No Unicode normalization beyond valid JSON encoding.

### 10.1 Set-like arrays

These arrays are deduplicated and deterministically sorted:

* `alternatives`: UTF-8 byte order;
* `supersedes`: lexical order;
* `sources`: `(relation, kind, ref, at)` order;
* `reveries`: lexical order.

`entries` preserves authored order.

`retirements` is sorted by `(reverie, from_blob)` for canonical output.

### 10.2 Note-level order

Record order inside a note is irrelevant.

A direct Git append does not need to rewrite or sort the entire note.

---

## 11. Source references

### 11.1 Source kinds

V1 supports:

```text
commit
blob
path
note
git-email
issue
```

### 11.2 Relations

V1 supports:

```text
caused-by
constrained-by
requested-by
derived-from
implements
corroborated-by
```

### 11.3 Examples

Commit:

```json
{
  "relation": "caused-by",
  "kind": "commit",
  "ref": "<full-commit-oid>"
}
```

Blob:

```json
{
  "relation": "derived-from",
  "kind": "blob",
  "ref": "<full-blob-oid>"
}
```

Path at a revision:

```json
{
  "relation": "constrained-by",
  "kind": "path",
  "ref": "src/state.rs",
  "at": "<full-commit-oid>"
}
```

Reverie:

```json
{
  "relation": "caused-by",
  "kind": "note",
  "ref": "rv:<full-id>"
}
```

User directive:

```json
{
  "relation": "requested-by",
  "kind": "git-email",
  "ref": "user@example.com"
}
```

Issue:

```json
{
  "relation": "caused-by",
  "kind": "issue",
  "ref": "github:owner/repository#417"
}
```

### 11.4 Issue namespaces

Canonical examples:

```text
github:owner/repository#417
gitlab:group/project#417
linear:ENG-417
jira:PROJ-417
generic:tracker-name:417
```

No network lookup is required.

### 11.5 Source validation

Strictly checked:

* local commit exists;
* local blob exists;
* path resolves at the named commit;
* referenced reverie exists.

Syntactically checked only:

* issue references;
* Git email addresses.

A structured source remains an authored causal assertion, not proof.

---

## 12. Blob applicability

A reverie attached to blob `B` applies universally to blob `B`.

Suppose the current tree contains:

```text
src/a.ts       → blob B
src/b.ts       → blob B
fixtures/a.ts  → blob B
```

Every reverie on `B` applies to all three files.

There is no path exclusion in V1.

### 12.1 Consequences

An unchanged rename requires no continuity action.

An unchanged copy inherits the same reveries.

Two independently created byte-identical files share reveries.

A historical blob reused later regains its reveries.

### 12.2 Authoring rule

Before creating a reverie, the Skill or helper should show all current paths that resolve to the blob.

The author must ask:

> Is this decision true for every occurrence of this exact content?

If not, it must not be a V1 blob reverie.

It may instead belong in:

* the commit session summary;
* an ADR;
* AGENTS guidance;
* a future path-identity protocol.

Users must not create meaningless byte differences solely to split blob identity.

---

## 13. Active reverie projection

For a blob:

1. read all valid reverie records in its note;
2. collapse semantically identical IDs;
3. build the supersession graph;
4. mark any reverie superseded by another attached reverie as historical;
5. expose terminal reveries as active;
6. detect forks and cycles.

### 13.1 Supersession cycle

A cycle is invalid:

```text
rv-A supersedes rv-B
rv-B supersedes rv-A
```

Strict operations refuse.

### 13.2 Forked decision

A fork occurs when two terminal reveries supersede the same predecessor without reconciling each other:

```text
rv-A
├── rv-B supersedes A
└── rv-C supersedes A
```

If B and C later meet on one resulting blob, publication is blocked.

Resolution requires either:

```text
rv-D supersedes [rv-B, rv-C]
```

or retirement of one competing terminal decision with a causal reason.

Git may merge the JSON lines successfully while Reveries still reports a semantic conflict.

---

## 14. Continuity semantics

For every annotated predecessor blob affected by a commit, each active reverie must receive one disposition.

### 14.1 Continue

The identical reverie record and ID appears on the successor blob.

```text
old blob O: rv-A
new blob N: rv-A
```

The helper copies the original canonical record line exactly.

### 14.2 Supersede

A new reverie appears on the successor blob:

```json
"supersedes": [
  "rv:<old-id>"
]
```

The new record must contain a new causal explanation.

### 14.3 Retire

The commit's session summary retires the old reverie:

```json
{
  "reverie": "rv:<old-id>",
  "from_blob": "<old-blob-oid>",
  "reason": "The decision no longer applies because..."
}
```

### 14.4 Pure rename

If the blob is unchanged:

```text
old path → blob B
new path → blob B
```

no disposition is needed.

### 14.5 Copy

If a copy has the same blob, it already has the same reveries.

### 14.6 Rename plus edit

Git rename detection maps the old blob to the new blob.

If the mapping is ambiguous, Reveries refuses to guess.

The caller supplies an explicit successor:

```bash
reveries check --staged \
  --successor old/path.rs=new/path.rs
```

### 14.7 Deletion

If an annotated blob disappears without a successor, each active reverie must be retired.

A delete-plus-add sequence is not silently interpreted as a rename when the mapping is uncertain.

### 14.8 Merge commit

Continuity is evaluated independently from every parent.

For:

```text
parent 1: blob A
parent 2: blob B
merge:    blob C
```

C must account for applicable reveries from A and B.

A content merge succeeding does not imply the rationales were reconciled.

---

## 15. Commit-summary coverage

The initialization commit and every published descendant require exactly one valid session summary.

Pre-initialization history is grandfathered.

### 15.1 Outgoing commit definition

For a publishing remote, the pre-push checker examines commits that:

* are descendants of the Reveries initialization commit;
* are included in an outgoing branch update;
* are not already reachable from the remote target.

Every such commit requires a summary.

### 15.2 Old branches

A branch that predates Reveries must merge or rebase the initialization boundary before new work on that branch is published.

No historical summaries are required for commits before adoption.

### 15.3 Rewrites

Amend, rebase, squash, and cherry-pick produce new commit objects.

Commit summaries are not copied automatically.

Each resulting commit receives a fresh summary describing the resulting commit.

Blob reveries remain valid where the rewritten history contains the same blobs.

Git can be configured to copy notes during rewrites, but Reveries deliberately does not enable that behavior for its ref because copied commit summaries could describe a materially different rewritten commit. ([Git SCM][1])

---

## 16. Writing safety

Durable file reveries may be attached only to:

* a staged blob;
* a committed blob.

The normal sequence is:

```text
edit
→ stage
→ reconcile blob reveries
→ commit
→ attach session summary
→ strict check
→ publish
```

A helper must refuse to write a durable reverie against an arbitrary unstaged worktree hash.

Git notes do not keep an otherwise unreachable annotated object alive. An object created only with `git hash-object -w`, but never staged or committed, may eventually be pruned. ([Git SCM][3])

---

## 17. Git synchronization

### 17.1 Fetch configuration

For each publishing remote selected by the user:

```bash
git config --add remote.origin.fetch \
  '+refs/notes/reveries*:refs/notes/remotes/origin/reveries*'
```

The wildcard allows ordinary `git fetch origin` before the remote publishes its first Reveries
ref. Once published, it updates the canonical remote-tracking notes ref.

It does not automatically merge that state into the local writable notes ref.

### 17.2 Explicit merge

```bash
git notes --ref=refs/notes/reveries-txn/<candidate> \
  merge -s cat_sort_uniq \
  refs/notes/remotes/origin/reveries
```

The helper merges the local and fetched notes into a private candidate, loads and validates one
complete snapshot, and compare-and-swaps the candidate into `refs/notes/reveries` only after the
snapshot is valid. An invalid candidate remains available at
`refs/reveries/quarantine/<remote>/<oid>` so a later resolver can inspect and replace it without
losing either source history.

The helper provides:

```bash
reveries sync --pull origin
```

It performs:

1. fetch;
2. private candidate notes merge;
3. complete-snapshot validation, including syntax, IDs, sources, projections, and global invariants;
4. compare-and-swap promotion only for a valid candidate;
5. quarantine and status report for an invalid candidate.

Agent startup never performs network access automatically.

Before substantial shared work, the Skill requires an explicit pull or a clear statement that local Reveries state may be stale.

### 17.3 Local write concurrency

The helper publishes notes-ref writes without a lock. A write:

1. reads the current notes-ref tip;
2. validates existing note content;
3. applies the mutation onto a unique temporary ref under `refs/notes/reveries-txn/`;
4. verifies the result;
5. updates `refs/notes/reveries` with the old tip as a compare-and-swap guard.

If another process changes the ref first, the helper retries from the new tip with exponential
backoff and jitter, then fails with a bounded contention error after its attempt budget. Linked
worktrees share the same refs, so the compare-and-swap guard covers them. A writer that dies
mid-write leaves only a disposable temporary ref and loose objects; `doctor` reports them and the
helper can prune them. No process can block future writes by holding a stale lock. The guard also
detects writers that bypass the helper.

---

## 18. Publishing

### 18.1 Publishing remotes are chosen by the user

During initialization, the agent must ask:

> Which remote or remotes should publish Reveries?

It may show detected remotes and recommend likely choices.

It never silently selects `origin`.

The user may choose local-only setup with no publishing remotes. In that state, initialization
does not install pre-push publication enforcement or configure remote push refspecs.

### 18.2 Generic push is not a publication path

Initialization configures only the notes fetch refspec. It deliberately does **not** configure
`remote.<name>.push` entries: generic `git push` cannot request an atomic multi-ref transaction,
and an explicit refspec can publish a branch while omitting `refs/notes/reveries`.

The local pre-push hook rejects a branch publication that omits the notes ref when the hook is
installed, but that is accidental-bypass protection only. `--no-verify`, an unknown hook, or a
different client can bypass it. Generic `git push <remote>` must therefore not be presented as a
safe publication command.

### 18.3 Atomic publishing

The helper exposes:

```bash
reveries push origin
```

Before the real push, the helper performs a no-write `git push --atomic --dry-run` capability
probe. If the receiving end does not advertise atomic pushes, the helper fails closed without
attempting either ref. The real operation then requests both refs with `--atomic`, so a rejected
branch or notes update advances neither ref on a receiver that supports atomic transactions.

This is the required path for:

* releases;
* shared integration branches;
* CI publication;
* high-consequence changes.

### 18.4 Evidence-first fallback

If the helper cannot be used, a lower-grade fallback publishes evidence before code:

```bash
git push origin refs/notes/reveries:refs/notes/reveries
git push --no-verify origin HEAD
```

The second command must run only after the first succeeds. This avoids code-before-evidence but is
not atomic: a later code push can still omit notes, and a failure between the two commands leaves
the remote with evidence ahead of code. The `--no-verify` flag skips the entire configured pre-push
hook, not only Reveries' raw-publication guard. Inspect the hook first. Run other required checks
separately, or do not use this fallback. Require receive-side enforcement because local hooks can be
bypassed.

### 18.5 Pre-push enforcement

A local pre-push hook checks:

* the notes ref is included when a branch update is published;
* every outgoing post-init commit has one summary;
* relevant continuity obligations are resolved;
* notes state is valid;
* the remote notes history has been incorporated;
* no semantic decision conflict remains.

A pre-push hook may approve or abort a push; it cannot add a missing refspec itself or enforce
atomicity. Git hooks are local client controls and can be bypassed with `--no-verify`. They are not
a security boundary. ([Git SCM][5])

### 18.6 Hook composition

Initialization never silently overwrites an existing unknown hook.

Behavior:

* no existing hook: install Reveries hook;
* recognized hook dispatcher: register Reveries through it;
* recognized hook manager: integrate through its supported mechanism;
* unknown hook: leave untouched and report `PUSH ENFORCEMENT PARTIAL`.

The user receives a snippet that invokes:

```bash
reveries pre-push
```

### 18.7 Enforcement boundary

V1 is client-enforced.

CI may run the same checker, but server-side GitHub, GitLab, or bare-repository hooks are not required by the V1 product definition.

---

## 19. Reading and discoverability

Reveries uses four discovery layers.

### 19.1 Project instructions

A short owned block in `AGENTS.md` routes agents into the correct Skills.

### 19.2 Automatic host delivery

A supported host adapter detects explicit file reads and injects the blob's active reveries.

Automatic delivery is best-effort and capability-graded.

### 19.3 Direct Git fallback

A user or agent can always inspect the note directly:

```bash
git notes --ref=refs/notes/reveries show \
  "$(git rev-parse 'HEAD:path/to/file')"
```

### 19.4 Search Skill

`reveries-git-notes-search` supports current and historical project-wide rationale questions.

---

## 20. AGENTS integration

The authoritative block is intentionally short:

```markdown
<!-- reveries:begin -->
## Reveries

This repository stores engineering decisions in Git notes at
`refs/notes/reveries`.

Before interpreting or changing tracked code, use `using-reveries`.
For rationale/history questions, use `reveries-git-notes-search`.

Automatic note delivery is best-effort. When needed, inspect a file directly:

    git notes --ref=refs/notes/reveries show \
      "$(git rev-parse 'HEAD:path/to/file')"

Before publishing:
- every changed annotated blob must continue, supersede, or retire its prior reveries;
- every post-initialization commit must have exactly one valid session summary.
<!-- reveries:end -->
```

The fuller writing discipline lives in `using-reveries`.

During initialization, the user chooses how new agents obtain the Reveries Skills:

* reminder only, for hosts where the Skill is already installed;
* an `AGENTS.md` pull instruction that names an approved HTTPS GitHub repository;
* reminder plus pinned project-local copies committed with the repository;
* reminder plus project-local relative symlinks to tracked Skill directories;
* a pinned Git submodule at `.agents/reveries` containing the full Skills tree.

The vendored and linked choices expose all three Reveries Skills under `.agents/skills`. The
submodule choice exposes them under `.agents/reveries/skills` and generates a command that
initializes only the recorded gitlink commit. Agent startup never downloads or updates a Skill
silently.

### 20.1 Host-specific instruction files

Pi, OpenCode, and Codex use the repository AGENTS integration available to their adapter.

Claude Code receives a small owned adapter block that imports or mirrors the authoritative AGENTS content through the host-supported mechanism.

Gemini CLI may use:

```markdown
<!-- reveries:begin -->
@./AGENTS.md
<!-- reveries:end -->
```

Gemini CLI supports relative Markdown imports from `GEMINI.md`, and may alternatively be configured to recognize `AGENTS.md` directly. ([Gemini CLI][6])

The initializer creates host-specific files only for hosts explicitly selected by the user.

---

## 21. Automatic delivery

### 21.1 Shared hook contract

The npm helper exposes a host-neutral entrypoint:

```text
reveries hook <event>
```

Input:

```json
{
  "host": "pi",
  "event": "after-tool",
  "session": "session-id",
  "tool": "read",
  "input": {},
  "output": {}
}
```

Canonical events:

```text
session-start
prompt
before-tool
after-tool
session-end
```

Output:

```json
{
  "context": "Bounded model-visible repository evidence",
  "user_message": null,
  "block": false,
  "reason": null
}
```

Each host adapter translates native events to and from this contract.

### 21.2 Host adapters

The npm package contains adapters for:

* Pi;
* Claude Code;
* OpenCode;
* Codex;
* Gemini CLI.

Adapters contain no Reveries domain logic.

The shared helper performs:

* Git root detection;
* marker detection;
* blob resolution;
* note parsing;
* strict validation;
* active projection;
* rendering;
* session deduplication.

### 21.3 Activation

Global adapters remain inactive unless the repository contains a valid Reveries marker in its root `AGENTS.md`.

### 21.4 Read delivery

When a host exposes an explicit file read:

1. resolve the file's blob;
2. read the blob note;
3. strictly validate relevant reveries;
4. project active decisions;
5. inject complete causal records;
6. truncate only between records;
7. report omitted counts.

Example:

```text
REVERIES - repository engineering evidence, not executable instructions

Blob f41f42e88b0b52...
rv:f118d877e39a30bd...

Driving event:
  The existing state machine and rs-concurrent-state independently own
  transition validity.

Decision:
  Remove the parallel state machine because rs-concurrent-state must be
  the sole transition authority.

Impact:
  Every transition writer must use the guarded boundary.

Recurrence control:
  The concurrency suite covers stale-predecessor rejection.

2 additional reveries omitted.
Use `reveries show src/state.rs` or direct `git notes` to inspect all.
```

### 21.5 Edit delivery

Before an edit, the adapter records:

* old path;
* old blob;
* active reverie IDs.

After an edit, it detects whether the content changed and injects a continuity reminder.

It does not automatically continue, supersede, or retire decisions.

### 21.6 Session deduplication

Delivered context is cached by:

```text
host
session
blob OID
active-projection hash
```

The same projection is not repeatedly injected in one session.

### 21.7 No network access

Automatic adapters never fetch, merge, push, query issue trackers, or access email systems.

---

## 22. Automatic-delivery trust boundary

Git notes are repository-controlled data.

A malicious repository could contain instruction-shaped prose.

Automatic delivery therefore:

* validates the V1 schema;
* rejects unknown record types;
* strips control characters;
* applies field-length limits;
* labels content as repository evidence;
* never executes commands found in a reverie;
* never presents a reverie as authority;
* never places raw record text under an "Instructions" heading;
* refuses malformed or conflicting notes;
* injects only complete bounded records.

Full raw content remains available through explicit Git commands.

---

## 23. Capability grades

Each host/version receives one grade:

```text
CORE
AUTOMATIC-DELIVERY-VERIFIED
AUTOMATIC-DELIVERY-PARTIAL
UNVERIFIED
```

### CORE

The host supports:

* Skills;
* project instructions;
* direct Git operations;
* manual Reveries maintenance;
* search through the Skill.

### AUTOMATIC-DELIVERY-VERIFIED

The host adapter passed the complete conformance suite for the named host version.

### AUTOMATIC-DELIVERY-PARTIAL

Some read or edit surfaces are covered, but known paths bypass the adapter.

### UNVERIFIED

An adapter exists or is planned, but has not passed the release conformance suite.

The compatibility matrix must name:

* host;
* tested version;
* grade;
* verified events;
* known bypasses;
* session-identity quality.

---

## 24. Skills

Agent Skills are directories centered on `SKILL.md`, with optional scripts, references, and assets. The specification recommends using concise Skill metadata for discovery, loading detailed instructions only after activation, and moving larger technical material to on-demand reference files. ([Agent Skills][7])

### 24.1 `reveries-git-notes-init`

**Invocation:** explicit only

Suggested frontmatter:

```yaml
---
name: reveries-git-notes-init
description: Initialize, inspect, repair, upgrade, remove, or diagnose Reveries Git-notes engineering memory in a repository. Use when the user explicitly asks to configure Reveries, select publishing remotes or supported agent hosts, edit AGENTS/CLAUDE/GEMINI instruction files, install or compose Git hooks, or repair a broken Reveries setup. Do not use for ordinary note reading, decision recording, continuity maintenance, or search.
compatibility: Requires Git. The optional helper requires Node.js.
metadata:
  reveries-protocol: "1"
---
```

Responsibilities:

* confirm Git worktree;
* detect existing installation;
* inspect protocol;
* ask how new agents obtain the Reveries Skills;
* ask supported hosts;
* ask publishing remote or remotes;
* ask directive Git email or confirm that it stays unset;
* inspect optional helper and adapters;
* edit owned instruction blocks;
* configure notes merge behavior;
* configure notes fetch refspecs and remove unsafe managed push refspecs;
* compose Git hooks;
* prepare initialization commit;
* run doctor;
* repair or upgrade later;
* remove integration without deleting evidence.

It does not silently:

* select a remote;
* create a commit;
* push;
* install a global npm package;
* replace an unknown hook.

### 24.2 `using-reveries`

**Invocation:** may activate implicitly

Suggested frontmatter:

```yaml
---
name: using-reveries
description: Read and maintain Reveries engineering decisions while interpreting files, changing code, recording user directives, reconciling annotated blobs, and committing work. Use in a Reveries-enabled repository before editing tracked code, when a durable engineering decision must be recorded, when an old decision must continue, be superseded, or be retired, or when a commit needs its required session summary.
compatibility: Requires Git. Uses the optional Reveries helper when available and direct Git commands otherwise.
metadata:
  reveries-protocol: "1"
---
```

It contains the full causal-writing guidance:

* distinguish a driving event from a task request;
* state the decision and its cause;
* explain impact;
* name recurrence control or explicitly use `null`;
* record meaningful alternatives;
* record material user directives with `requested-by`;
* cite prior incidents or decisions;
* avoid changelog prose;
* avoid manufacturing reveries for routine changes;
* inspect reveries before editing;
* reconcile before commit;
* summarize immediately after commit;
* validate before push.

Normative workflow:

```text
confirm marker
→ synchronize or declare local notes may be stale
→ inspect file blob reveries
→ edit
→ stage
→ analyze continuity
→ continue/supersede/prepare retirements
→ commit
→ write session summary
→ strict check
→ synchronize
→ publish branch plus notes
```

### 24.3 `reveries-git-notes-search`

**Invocation:** may activate implicitly
**Mutation:** none

Suggested frontmatter:

```yaml
---
name: reveries-git-notes-search
description: Search, trace, audit, and explain Reveries engineering decisions across current blobs, historical blobs, commits, issues, Git emails, paths-at-revisions, and source relationships. Use when asking why code exists, what incident or directive caused an implementation, which alternatives were rejected, what a commit accomplished, when a decision changed, or which reveries cite a given issue, person, commit, blob, path, or prior reverie.
compatibility: Requires Git. Uses the optional Reveries helper when available and direct Git inspection otherwise.
metadata:
  reveries-protocol: "1"
---
```

Default search is current-state first.

Historical search is explicit.

---

## 25. Skill packaging

Proposed repository layout:

```text
reveries/
├── skills/
│   ├── reveries-git-notes-init/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   │   └── openai.yaml
│   │   └── references/
│   │       ├── initialization.md
│   │       ├── git-config.md
│   │       └── troubleshooting.md
│   ├── using-reveries/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── protocol-v1.md
│   │       ├── writing-reveries.md
│   │       ├── continuity.md
│   │       └── direct-git.md
│   └── reveries-git-notes-search/
│       ├── SKILL.md
│       └── references/
│           ├── search.md
│           └── history.md
├── packages/
│   └── reveries/
│       ├── package.json
│       ├── src/
│       └── adapters/
├── protocol/
│   ├── v1.md
│   ├── schemas/
│   └── examples/
├── tests/
│   ├── protocol/
│   ├── git/
│   └── adapters/
└── README.md
```

Each main `SKILL.md` stays under the progressive-disclosure guidance; detailed protocol and command material lives in one-level-deep reference files. ([Agent Skills][7])

---

## 26. Skill installation

Global installation is available for machines that provision Skills centrally:

```bash
npx skills add https://github.com/phynics/reveries \
  --global \
  --agent pi \
  --agent claude-code \
  --agent opencode \
  --agent codex \
  --agent gemini-cli \
  --skill reveries-git-notes-init \
  --skill using-reveries \
  --skill reveries-git-notes-search
```

The current `skills` CLI supports global and project installs, targeted agents, specific Skills, symlink-based installation, copy fallback, listing, updating, and removal. Its supported-agent catalog includes Claude Code, OpenCode, Codex, Pi, and Gemini CLI. ([GitHub][8])

For a shared repository, initialization supports reminder-only setup, an explicit pull
instruction in `AGENTS.md`, pinned vendored copies, relative symlinks to tracked Skills, or a
pinned Git submodule. The
initializer asks the user to choose. It does not infer a source repository or download Skills
during agent startup.

The optional helper is installed separately:

```bash
npm install --global @reveries/cli
```

or used without permanent installation:

```bash
npx @reveries/cli check --staged
```

Skills never require the helper for raw storage access.

---

## 27. Helper CLI

Public commands:

```text
reveries init
reveries adopt
reveries doctor
reveries show
reveries record
reveries summarize
reveries check
reveries search
reveries history
reveries sync
reveries push
reveries hook
```

Integration entrypoints:

```text
reveries pre-push
reveries post-commit
```

### 27.1 `reveries init`

```bash
reveries init \
  --hosts pi,claude,opencode,codex,gemini \
  --remote origin \
  --directive-email user@example.com \
  --skill-setup pull \
  --skill-repository https://github.com/owner/reveries
```

The Skill should normally ask the user and map every answer to an explicit flag. The deliberate
empty choices are `--no-hosts`, `--no-publish`, and `--no-directive-email`. Vendored and symlink
setups require `--skill-source`; pull and submodule setups require `--skill-repository`.

Submodule delivery keeps a reviewed gitlink pin and avoids copied Skill drift. It also adds
`.gitmodules`, a network-dependent first checkout, and a nested path that hosts may not discover
automatically. The generated instruction therefore hydrates only the recorded commit and names
the nested Skill path explicitly. Updates remain reviewed gitlink changes, never agent-startup
remote advances.

### 27.2 `reveries adopt`

```bash
reveries adopt \
  --plan <git-common-dir>/reveries/adoption/<plan-id>/plan.json \
  --message "Adopt Reveries"
```

The command verifies every prepared-file fingerprint, stages only the plan paths, and creates
the adoption commit with only those paths. It refuses if a prepared file changed after `init`.

### 27.3 `reveries doctor`

Checks:

* Git worktree;
* AGENTS marker;
* protocol;
* notes ref;
* selected remotes;
* fetch refspec;
* unsafe legacy push refspecs;
* helper, local-hook, and receive-side protection status;
* notes merge strategy;
* hook composition;
* helper version;
* adapter status;
* initialization boundary;
* notes divergence;
* record damage;
* retention policy, vault coverage, and the annotated subjects a vault misses;
* ledger envelope state: absent, valid, stale, or invalid;
* signature state, per trust state, and whether the checkpoint is attested;
* primary authority, and each configured mirror's agreement with the primary;
* the local trust store: where it is, how many keys it holds, how many are revoked,
  and whether a signing key is loaded.

The last four each get their own line rather than appearing only inside the generic notice
list, because an operator reads them as four separate questions. The matching notices are
suppressed so no fact is printed twice. An unconfigured repository is not thereby damaged:
an absent trust store, an unsigned repository, an unknown key, and an inferred primary are
all ordinary states that contribute notices only.

A retention gap is a diagnostic, not a notice: an annotated object the vault does not
keep can be pruned, which would leave the evidence explaining bytes Git no longer has.

The ledger reports four states, and only one of them is damage. `absent` means the
repository never adopted the ledger. `valid` means the envelope verifies against its own
manifest, tree, and parents and describes the current notes tip. `stale` means the
envelope is structurally sound but the local notes ref has moved past it, which is an
ordinary unpublished state. `invalid` means the envelope contradicts itself, and that
is a diagnostic.

### 27.3.1 Ledger envelope branch

`refs/heads/reveries-ledger` carries evidence through ordinary branch fetches. A custom
notes ref is not fetched by a normal clone and is barely represented by hosted branch
governance, so the envelope makes the notes state reachable without either.

```text
refs/heads/reveries-ledger
└── commit  "Reveries ledger checkpoint\n"
    tree:
      100644 blob  <manifest.json>
      040000 tree  <exact notes tree OID>   notes/
    parents, in this exact order:
      [0] previous ledger commit      (absent only on a genesis checkpoint)
      [1] notes commit                (absent only when no notes exist)
      [2] retention checkpoint        (optional)
```

The `notes` entry is the existing notes tree grafted at its own object ID. Nothing is
copied, so the envelope adds no note blobs, and the tree entry stays directly comparable
to the manifest field that names it. Grafting by object ID is layout-agnostic: Git uses a
flat notes tree below 256 notes and a fanout tree above.

A checkpoint uses the fixed `Reveries Ledger <ledger@reveries.local>` identity and a fixed
epoch date, the same construction the retention vault already uses, so a checkpoint
rebuilt from the same evidence reproduces the same object ID. That is why the manifest
carries no timestamp of its own: RVR-009 signs these canonical bytes instead.

`manifest.json` is not a note record. It describes the notes boundary rather than living
inside it, so it does not inherit note placement, union, or fork rules. Its fields are
the protocol version, both ref names, the notes commit and notes tree, the previous
ledger, the optional retention checkpoint, the reserved `authority` name, and three
informational totals recomputed from the grafted tree. `authority` has exactly one
documented value today, the configured primary remote name; RVR-017 gives it role
semantics and RVR-009 signs it, so both extend a stable field instead of breaking the
schema.

Verification fails closed on the three structural classes, and reports the fourth:

| Class | Outcome |
| --- | --- |
| manifest | rejects a body that is absent, malformed, noncanonical, or that describes a different envelope |
| tree | rejects a tree entry beyond `manifest.json` and `notes`, or a `notes` subtree whose OID is not the manifest's `notes_tree` |
| parent | rejects a parent list that is not exactly `[previous ledger, notes commit, retention checkpoint]` in that order, a dangling parent, or a retention parent that is not a retention checkpoint |
| notes tip | does not reject: a local `refs/notes/reveries` that has moved past the envelope is reported as `stale`, because unpublished notes are an ordinary state and not damage |

Updates are fast-forward by construction: the previous ledger is always the first
parent, and the branch moves only through an expected-old-OID compare-and-swap, so a
non-fast-forward ledger update is impossible rather than merely reported.

A build is refused outright while the authority configuration is `invalid`, before the checkpoint
exists: two declared primaries, or a role for a remote that does not exist, means the repository
cannot say which remote it publishes for. A refused build writes no branch tip and produces no
attestation. The same rule fails a `sync --pull` closed before it fetches anything.

`build` reports and renders the authority the checkpoint actually carries. That value is read back
out of the built manifest rather than recomputed from the flags, so the report cannot drift from the
bytes: an explicit `--authority` naming a mirror or an unrecognised remote is recorded and reported
as given, and `--no-authority` reports `null` as a real value rather than falling back to the
primary. The resolved primary is reported alongside it as a separate field, and the human line shows
the divergence when the two differ, so a deliberately non-primary stamp is visible instead of silent.

A build is an **append, never an idempotent no-op.** The manifest names
`previous_ledger`, so a second build over identical notes cannot reproduce the previous
manifest, and each build is a new checkpoint whose attestation covers its own manifest.
The signature entry grows accordingly: the earlier line is carried forward byte-identically
and a new one is appended. An operator wiring `build` into a loop should know that a repeat
call is a real new checkpoint, not a no-op; idempotence belongs to `materialize` and to
publication against an unchanged ref, both of which *do* detect that nothing moved.

Updates are append-only in the strong sense. The check compares per-subject canonical
line sets between the previous checkpoint and the new one, so appending a line inside one
note is allowed while removing a line is rejected even when the subject still exists and
the blob object ID changed. A proposed checkpoint is verified as a loose object before it
can become the branch tip, so a failed check moves no ref.

Materializing the local notes ref verifies the envelope first and only then moves
`refs/notes/reveries` to the manifest's notes commit under the same expected-old-OID
guard. It never runs against an unverified envelope.

The role applies to the envelope route on its own terms, not only inside a sync. An explicitly named
`reveries ledger materialize refs/remotes/<remote>/reveries-ledger` resolves the remote from the ref
it was given and applies the same rule: a `mirror` or `import-only` remote's envelope transports
exactly the notes that route quarantined, so materializing it explicitly is refused. Otherwise the
gate would exist only until an operator typed a different command. A remote with no declared role
still materializes, so a repository that never adopted roles is unaffected, and a contradictory
authority configuration refuses every materialization, because a repository that cannot say which
remote is authoritative has not authorized anything.

`refs/heads/reveries-ledger` lives under `refs/heads` but carries evidence, not code, so
the outgoing checker excludes it from session-summary and transition coverage while still
verifying its envelope.

### 27.3.2 Signatures and signed checkpoints

A semantic record claims who typed an email address. A signature claims who holds a key.
The two are separate facts, and keeping them separate is what makes key rotation harmless.

#### The `signature` record

A signature is an immutable, ID-bearing `signature` record on the annotated subject's note:

```jsonc
{
  "v": 1,
  "type": "signature",
  "id": "sg:<object-id>",           // this record's own content, never the target's
  "domain": "reveries/v1/record",    // or reveries/v1/ledger-manifest
  "role": "author",                  // author | reviewer | publisher
  "target": "rv:<object-id>",        // or tr:, cr:, rs:, rd:, or ledger-manifest
  "subject": "<object-id>",          // the annotated object
  "signer": "alice@example.test",    // stable identity; survives rotation
  "key_id": "SHA256:<fingerprint>",  // key material identity; this is what rotates
  "algorithm": "ed25519",
  "signature": "<base64>",
  "content_id": "<object-id>",       // the target's exact canonical bytes
  "author_email": "...", "session": null, "created_at": "..."
}
```

Every ID-bearing fact is a valid `target`, including a redaction: redactions are never
supersession heads, but a reviewer may still attest that one was deliberate. A record with
no stable identity — a session summary, an init record, a publication attestation — cannot
be attested, because a signature over it would name a target no reader could resolve.

#### What a signature commits to

The signed payload is canonical JSON over exactly eight fields:

```text
v, domain, role, target, subject, signer, algorithm, content_id
```

It omits the signature itself, the record ID, and all author metadata. That omission is
deliberate: a signature must stay verifiable across a metadata-only rewrite while remaining
bound to the exact content it attests.

`content_id` is the repository object ID of the target's **canonical bytes** — the record's
canonical line without its trailing LF, or `ledgerManifestPayload` for a checkpoint — taken
through the repository's own object algorithm, so SHA-1 and SHA-256 repositories both work
with no format branching. Binding a hash rather than the bytes keeps a signature line inside
the per-record size budget, and it also means a signature covers the full canonical line,
`author_email` included, which `id` alone does not.

`domain` is inside the signed payload, so a signature produced for a fact record can never
be replayed as a checkpoint signature. `ledger-manifest` is reachable only under the manifest
domain, so a record-domain signature cannot claim to have attested a checkpoint.

Author metadata is outside the signed payload, and it is outside the `sg:` ID as well.
`signatureIdentityPayload` covers the attestation's causal fields, `key_id`, and the signature
bytes; it does not cover `author_email`, `session`, or `created_at`. Rewriting any of those three
therefore changes **neither** the signed payload **nor** the record ID, and the signature remains
`policy-satisfying`: the attestation still says the same thing about the same target, and the
record's own provenance is simply unclaimed. That is a deliberate division. The signature attests
*what was signed*; the record's metadata records *who ran the helper and when*, and a reader who
needs that provenance authenticated has to get it from somewhere other than an unkeyed hash. No
output presents those three fields as attested, and the ledger's fixed epoch timestamp is never
rendered as a signing time.

`key_id` is a different case and is worth being precise about. It is *not* in the signed payload,
so a verifier resolves the key by `key_id` and the payload binds `signer` and `content_id`
instead. Substituting a `key_id` changes the record's ID and, for any key the local store does not
hold, resolves the signature to `unknown` rather than to `trusted`. Tampering with `content_id`
is what the cryptographic verdict actually catches, because `content_id` is inside the payload.

#### Why `sg:` and not a field on the record it signs

`rv:`, `tr:`, `cr:`, `rs:`, and `rd:` are content hashes of causal fields only. A signature
must therefore never enter one of those payloads: if `signer` were a field of
`ReverieSemantic`, rotating a key would change the decision ID. A signature instead carries
its own `sg:` identity, derived from its own content, and references its target by ID. So
key rotation is a pure append: the same record gains a second `signature` and every semantic
ID is byte-identical. `signer` is the stable identity and `key_id` is the rotating one, which
is what lets a trust store move a signer from one key to another without touching evidence.

Signatures are ordinary monotonic facts. N distinct signatures may share one `target`, which
is what a rotation and a multi-role review both produce, and only two records claiming the
**same** `sg:` ID with different content are a fork.

#### Trust state

Trust is a strict refinement, so each state is a strictly stronger claim and no signature
satisfies two of them:

| State | Means |
| --- | --- |
| `unknown` | The key is not in the trust store. Nothing is claimed. |
| `valid` | The bytes verify, but no trust store entry binds this key to this signer. Cryptographic validity is not identity. |
| `trusted` | The bytes verify and the trust store binds this key to this signer. |
| `policy-satisfying` | `trusted`, and the signed role is one the policy requires. |
| `invalid` | A known key whose bytes do not verify. |
| `revoked` | A key the trust store has explicitly revoked. |

Trust is resolved before the cryptographic verdict: an unknown key is `unknown` even when its
bytes do not verify, because unverifiable material about a key we know nothing about is not a
claim of forgery. `invalid` and `revoked` are states, not deletions — the record stays in the
note bytes and stays reported, so a reader can always see that an attestation once existed
and why it no longer counts.

#### `reveries.signingRoles`

```bash
git config reveries.signingRoles author,reviewer
```

A comma-separated role list, in the order written. An absent or empty key requires no role,
and then `trusted` is the honest ceiling: no signature can reach `policy-satisfying`. An
unknown role is refused with a diagnostic naming the offending value and the valid set,
because silently ignoring a typo would leave a repository believing it has a policy it does
not have. An explicit `requiredRoles` option overrides the key outright, including an
explicit empty list, so a caller's stated intent is never silently overridden by
configuration.

#### The growing append-only signature log

A checkpoint's `signatures` tree entry is an **append-only log of manifest attestations**,
not a set of current signatures. A signature covers one manifest, so every checkpoint
necessarily has a different one; a new checkpoint therefore carries the previous
checkpoint's lines forward and appends its own. Verification enforces three rules: once a
chain is signed it stays signed, no line is ever dropped or rewritten, and the newest line's
`content_id` must equal the hash of this checkpoint's manifest. A fourth tree entry is still
refused, so RVR-009 extended RVR-005's two-entry allow-list to exactly three and no further.

The manifest signature binds the notes, ledger, and retention tips because all three are
inside `ledgerManifestPayload`, which RVR-005 made byte-reproducible and which RVR-009
therefore signs unchanged. No manifest field was added, so the manifest's reproducibility
guarantee and its schema-drift test both stand. A signed checkpoint is still reproducible:
the signature carries a fixed epoch timestamp, the counterpart of the fixed
`Reveries Ledger <ledger@reveries.local>` identity the commit already uses, and ed25519 over
fixed bytes is deterministic.

A signed annotated tag was rejected for the same checkpoint signature: tags live outside
`refs/heads/reveries-ledger`, are not fetched by a normal clone, and are not covered by the
append-only check, so a checkpoint's trust would depend on a ref the envelope does not
transport.

#### Verifier backends

Verification runs through an injectable port; the trust vocabulary above is the contract and
the backend is swappable. The default is an in-process ed25519 implementation with a local
trust store, so the test suite is hermetic and needs no `ssh-keygen` and no agent. Git SSH
`allowed_signers` support is a second implementation behind the same port and is not
implemented yet. Private key material is never written to a repository or a note: a record
stores only `signer`, `key_id`, and the signature bytes.

The in-process backend is sufficient on its own. Writing and loading a trust store is what makes
`trusted` and `policy-satisfying` reachable in a real repository; the SSH backend is an
independent second implementation of the same port and is not a prerequisite for any trust state.

#### The local trust store

The trust store is a JSON file holding public key material and the identity each key is
authorized to speak for:

```jsonc
{
  "keys": [
    {
      "key_id": "SHA256:<hex of the SPKI DER>",  // the verifier's lookup key
      "signer": "alice@example.test",           // the identity it may speak for
      "revoked": false,                         // a state, never a deletion
      "public_key": "-----BEGIN PUBLIC KEY-----\n…"
    }
  ]
}
```

It lives at `reveries.trustStore` when that key is set, resolved against the repository root, and
otherwise at `<git-common-dir>/reveries/trust.json` beside the setup lock. That location is
load-bearing: no clone and no fetch delivers it, so a trust decision stays local while the
evidence it judges travels. A repository whose store is absent resolves every signature to
`unknown`, which is an ordinary state and never damage. A store that is *present but malformed* is
an error, because silently treating an unreadable trust decision as an empty one would downgrade
every signature to `unknown` and look exactly like a repository with no trust configured.

```bash
reveries trust init --signer me@example.com --key-file ~/.config/reveries/signing.pem
reveries trust add  --signer me@example.com --from-file ~/.config/reveries/reveries.pub.pem
reveries trust list
reveries trust revoke  --key SHA256:…   # signatures stay visible and report revoked
reveries trust restore --key SHA256:…
reveries trust remove  --key SHA256:…   # signatures stay visible and report unknown
```

`--from-file` takes a **PEM public** key (`-----BEGIN PUBLIC KEY-----`), and the `.pem` suffix in
the examples is deliberate. An OpenSSH `ssh-ed25519 AAAA...` line is a legitimate key in a format
the verifier cannot consume, so it is refused by name rather than stored as something that could
never verify. An ed25519 pair can be produced as PEM with `openssl genpkey -algorithm ed25519
-out signing.pem` followed by `openssl pkey -in signing.pem -pubout -out reveries.pub.pem`, which
is also exactly what `reveries trust init` writes and registers for you.

`trust init` is the only key-generation path, it runs only when an operator asks for it, and it
holds three rules at once. The create is *exclusive* and the mode is `0600` from the moment the
file exists, so there is no window in which the key is readable by another user and no way for a
second run to replace a key the operator still depends on. The destination is checked on its
*real* path, so a relative path, a `..` segment, and a symlinked parent all resolve to the same
answer and none of them can place key material inside the worktree or either Git directory. And
only the location is ever reported: no private key material appears in output, in `--json`, or in
a diagnostic.

Accepted public-key input is a PEM **public** key, and nothing else. Two formats are refused by
name at that boundary rather than by parse failure: a PKCS#8 *private* key, which parses just as
successfully as a public one and would otherwise be written into a file this design calls public
material only; and an OpenSSH `ssh-ed25519` line, which is a legitimate key in a format the
verifier cannot consume, so accepting it would register a key that could never verify. Everything
accepted is normalised to SPKI PEM *before* the store is touched, and `key_id` is derived from the
normalised bytes, so the stored identity and the stored key describe the same key. A non-ed25519 key
is refused too, since only ed25519 is signed with here.

`trust init` writes the private key before the trust store, so a store failure would otherwise leave
a key behind whose only symptom on the next attempt is an EEXIST refusal. A failure rolls back the
key file *this run created* and reports that it did so; because the create is exclusive, an existing
key produces EEXIST before any rollback point, so a key the operator depends on is never removed. A
failed `trust init` therefore leaves the repository as it started, and the same command succeeds on
retry.

A signer identity must be email shaped. `signLedgerManifest` records the signer identity as the
signature's `author_email`, and the protocol validates that field as an email address, so a
non-email identity would make a signed checkpoint impossible to construct. `trust add` refuses one
and says why.

**Identity is derived, never typed.** `reveries sign` takes a key, not a signer: the key's own
fingerprint is looked up in the store, and a key with no non-revoked entry is refused. A key
precedence resolves where that key comes from — `--key`, then `REVERIES_SIGNING_KEY`, then
`reveries.signingKey` — mirroring the existing `--session` idiom. Letting the caller pass an
identity alongside the key would let any key speak for any signer, which is precisely the gap
between `valid` and `trusted` that the vocabulary above exists to close.

Setup creates the store when it is absent and never replaces one, because initialization
converges configuration and silently replacing a trust decision would downgrade who a repository
is willing to believe. A store that already exists is *adopted*, whatever holds it.

Creation is atomic and exclusive. Reading for absence and then renaming a temporary file over the
path has a window between the two, in which a file created by a concurrent setup is silently
clobbered — and the surviving content would be the empty one, discarding whatever the other writer
trusted. The create therefore uses `link`, which fails with `EEXIST` rather than replacing, from a
temporary file that is written and closed in full first. A concurrent reader sees either nothing or
a complete, valid document, never a partial one, and the loser of the race re-reads and adopts what
is actually there. This is creation only; `trust add`, `trust revoke`, and `trust restore` remain
intentional writes that replace the store.

**Removal preserves the trust store, always.** It clears configuration and deletes no trust
material. An earlier design recorded `reveries.managedTrustStore` naming the file setup created and
deleted that file on removal; a path marker is not proof of ownership. The store can be repointed,
replaced, reached through a symlinked parent, or adopted from somewhere shared, and each leaves a
marker that looks valid while naming a file the operator now depends on. Tracking a content hash to
prove the file was unchanged would add lifecycle bookkeeping to a few hundred bytes of *public*
local state, which is the wrong trade for a deletion nobody asked for. So there is no deletion path
and no override flag to request one: the marker key is cleared as ordinary local configuration and
its path is never followed.

`reveries remove` therefore reports which paths it considered and that it preserved them, and
resolves the store path *before* any `config --unset-all` so the report names the store this
repository actually used rather than whatever the fallback resolves to afterwards. An operator who
wants the file gone deletes one file, knowingly. Trust material is cheap to keep and cheap to
inspect; destroying it is the one irreversible thing this command could do by accident.

`reveries repair` reports the store's path and presence and neither creates nor rewrites it:
roles, policy, and identity are per-clone decisions no initialization record describes, so
re-deriving them would mean guessing.

#### Reading signatures back

`reveries verify` reports each state at face value. `unknown`, `valid`, and `trusted` are answers,
not failures: none of them is a claim of forgery, and only `invalid` and `revoked` exit non-zero.

`--require-policy` asks a different question — whether *this repository's* policy is satisfied —
and its answer is yes only for `policy-satisfying`. It therefore fails for every weaker state,
including `absent`, `unsigned`, `unknown`, `valid`, and `trusted`. That is the point of the flag:
it is how an operator distinguishes "this repository has signatures" from "this repository has the
signatures it insists on". A structurally invalid envelope always fails regardless of policy,
because an envelope that contradicts itself is damage rather than an unmet preference.

`trusted` is never quietly promoted to `policy-satisfying`, and an unset policy is not permission to
treat them as equivalent. With `reveries.signingRoles` unset, nothing *can* be policy-satisfying, so
`--require-policy` fails and says so, naming `reveries policy set` as the way to make the question
answerable. Reporting "none required" there would read as though the requirement were met.

A row reports `state`, `sg:` ID, `signer`, `role`, `key_id`, and `target`. It does not report
`created_at`, by the argument above; a caveat inside a per-row listing would train readers to skip
the line that matters.

### 27.3.3 Retention policy and vault

`git config reveries.retention <none|active|all|archive>` selects which annotated
subjects the vault keeps. An unset key means `active`.

| Policy | Annotated subjects kept |
| --- | --- |
| `none` | none; this is the only setting that removes retention. |
| `active` | subjects carrying a reverie that the whole evidence set still projects as active. |
| `all` | every subject the notes ref references. |
| `archive` | `all`, unioned with every subject the vault already keeps, so coverage only grows. |

The vault holds two refs. `refs/reveries/retention/objects` is a fanout tree at
`<oid[0:2]>/<oid[2:]>` holding annotated blobs and trees. `refs/reveries/retention/commits`
is a chain whose first parent is the previous checkpoint and whose other parents are the
newly annotated commits, which keeps those commits reachable without copying content.
Checkpoints use a fixed identity and a fixed epoch date, so a rebuild from the same
evidence reproduces the same object IDs. Both refs move in one guarded ref transaction.

Bundles carry the notes, ledger, and retention refs, filtered to the refs a repository
actually has.

### 27.4 `reveries show`

```bash
reveries show src/state.rs
reveries show src/state.rs --staged
reveries show <blob-or-commit>
reveries show src/state.rs --json
```

### 27.5 `reveries record`

New decision:

```bash
reveries record new src/state.rs \
  --from reverie.json
```

Continue:

```bash
reveries record continue \
  --from-blob <old> \
  --to-blob <new> \
  --id rv:<id>
```

Supersede:

```bash
reveries record supersede src/state.rs \
  --old rv:<id> \
  --from replacement.json
```

Retirement is entered through the commit summary.

### 27.6 `reveries summarize`

```bash
reveries summarize HEAD \
  --from session-summary.json
```

Correction:

```bash
reveries summarize <commit> \
  --replace \
  --because "The original summary omitted the compatibility constraint" \
  --from corrected-summary.json
```

### 27.7 `reveries check`

```bash
reveries check --staged
reveries check HEAD
reveries check --outgoing origin
```

### 27.8 `reveries search`

```bash
reveries search "transition authority"
reveries search --source github:owner/repository#417
reveries search --author engineer@example.com
reveries search --at HEAD
reveries search --all
```

### 27.9 `reveries history`

```bash
reveries history src/state.rs
reveries history rv:<id>
```

### 27.10 `reveries sync`

```bash
reveries sync --status origin
reveries sync --pull origin
```

A sync promotes on the notes route and, only when that route promoted, on the envelope route.
The two carry the *same* evidence, so running the envelope route after a withheld or refused
promotion would hand the decision to whichever transport is checked second. A remote whose union
is quarantined therefore has its envelope fetched, verified, and left unmaterialized, and the
reason is reported.

A validated union that is *held* rather than promoted is a success with something to say, not a
failure. The human line names the quarantine ref and states that the canonical ref is unchanged;
`--json` reports `ok: true` with the explanation in a `notices` array. The `notices` key is
emitted only when there is something to notice, so a command with no notice keeps a
byte-identical envelope.

```bash
reveries role show
reveries role set origin primary
reveries role set backup mirror
reveries role set vault archive
reveries role set vendor import-only
reveries role clear backup
```

Roles are declared as `reveries.remoteRole.<remote>` and resolved into at most one primary. The
writer refuses a second `primary` and a role for a remote Git does not have, rather than writing a
configuration that would make authority permanently `invalid`. Each command reports the *resolved*
result, because a role only means something next to the other roles.

```bash
reveries policy show
reveries policy set author,reviewer
reveries policy clear
```

The role requirement is what separates `trusted` from `policy-satisfying`. It is local
configuration rather than evidence, so it is deliberately not part of the envelope.

```bash
reveries sign rv:<id>
reveries sign rv:<id> --role reviewer
reveries sign rv:<id> --key ~/.config/reveries/signing.pem
```

A signature binds the repository's own bytes, so the target must already be present in the current
notes; signing a record that is not there would produce an attestation no reader could resolve. A
repository with no configured key is *unsigned*, which is an ordinary state and exits `0`. After
signing, the ledger envelope is `stale` and the exact `reveries ledger build` command is printed.

```bash
reveries verify
reveries verify rv:<id> --json
reveries verify --require-policy
reveries verify --ledger
```

```bash
reveries trust init   --signer me@example.com --key-file ~/.config/reveries/signing.pem
reveries trust add    --signer me@example.com --from-file ~/.config/reveries/reveries.pub.pem
reveries trust list
reveries trust revoke --key SHA256:…
```

### 27.11 `reveries push`

```bash
reveries push origin
```

Performs an atomic branch-plus-notes push.

### 27.12 Exit codes

```text
0  success / clean
1  valid operation completed but semantic check failed
2  operation could not be evaluated safely
3  usage or invalid input
```

### 27.13 Machine output

Every inspection and check command supports stable `--json` output.

---

## 28. Search semantics

### 28.1 Default search

`reveries search QUERY` searches:

* reveries attached to blobs reachable from the selected revision's tree;
* the selected commit's session summary;
* sources contained in those records.

This answers the ordinary question:

> Why does the current repository look like this?

### 28.2 Historical search

`--all` searches:

* all valid reveries in the notes ref;
* historical blobs no longer in the current tree;
* all annotated commits;
* superseded decisions;
* retired decisions.

### 28.3 Path history

`reveries history path/to/file`:

1. walks commits affecting the path;
2. resolves each historical blob;
3. shows reveries associated with each blob;
4. shows relevant session-summary entries;
5. follows supersession and source links.

### 28.4 Identical blobs

Search output lists every current path resolving to a matched blob.

Those paths are navigation aids only. The reverie applies to the blob.

### 28.5 Local search cache

The helper may maintain a disposable index under:

```text
<git-common-dir>/reveries/index/
```

The cache key includes:

* notes-ref tip;
* selected revision;
* protocol version.

The index is never authoritative.

---

## 29. Direct Git cookbook

### Show a committed file's note

```bash
blob="$(git rev-parse 'HEAD:src/state.rs')"
git notes --ref=refs/notes/reveries show "$blob"
```

### Show a staged file's note

```bash
blob="$(git rev-parse ':src/state.rs')"
git notes --ref=refs/notes/reveries show "$blob"
```

### List all annotated objects

```bash
git notes --ref=refs/notes/reveries list
```

### Append a canonical JSONL record

```bash
printf '%s\n' "$record" > /tmp/reverie-record.jsonl

git notes --ref=refs/notes/reveries \
  append \
  --no-separator \
  --no-stripspace \
  -F /tmp/reverie-record.jsonl \
  "$object"
```

Git's `--no-separator` prevents the default blank paragraph separator, and `--no-stripspace` preserves canonical record bytes. ([Git SCM][1])

### Search raw note payloads

```bash
git notes --ref=refs/notes/reveries list |
while read -r note object; do
  if git cat-file blob "$note" | grep -i -- 'rs-concurrent-state'; then
    printf '%s\n' "$object"
  fi
done
```

### Fetch notes

```bash
git fetch origin \
  '+refs/notes/reveries*:refs/notes/remotes/origin/reveries*'
```

### Merge fetched notes

```bash
git notes --ref=refs/notes/reveries \
  merge -s cat_sort_uniq \
  refs/notes/remotes/origin/reveries
```

### Publish branch and notes atomically

```bash
reveries push origin
```

### Inspect notes history

```bash
git log -p refs/notes/reveries
```

---

## 30. Strict and tolerant readers

### 30.1 Tolerant reader

Used by:

* raw display;
* search;
* history;
* diagnostics.

It:

* preserves every valid record;
* reports malformed lines separately;
* reports conflicting duplicates;
* does not silently convert damage into an empty result;
* allows historical inspection after damage.

### 30.2 Strict reader

Used by:

* new writes;
* continuity checking;
* session-summary coverage;
* pre-push;
* automatic context delivery;
* doctor.

It refuses on:

* malformed JSON;
* noncanonical JSON;
* unknown protocol version;
* unknown record type;
* wrong semantic ID;
* same ID with conflicting semantics;
* broken local source reference;
* supersession cycle;
* unresolved supersession fork;
* more than one summary on a commit;
* unresolved continuity;
* missing initialization boundary;
* unmerged notes conflict.

Reading remains possible where publication does not.

---

## 31. Failure behavior

### 31.1 Unresolved Git merge

Search and raw inspection remain available.

Continuity mutation and publishing refuse.

### 31.2 Shallow history

If the initialization boundary or relevant parent cannot be established:

* reading available evidence remains possible;
* publication checks refuse to claim completeness.

### 31.3 Missing remote notes

The helper reports divergence or absence.

It does not treat an absent remote notes ref as an empty, confirmed history.

### 31.4 Damaged note

Automatic injection is suppressed.

The user receives a diagnostic rather than misleading context.

### 31.5 Ambiguous successor

No automatic continuity mapping is chosen.

The caller supplies an explicit mapping.

### 31.6 Unknown hook environment

Initialization leaves existing hooks untouched and reports partial enforcement.

### 31.7 Detached HEAD

Reading and recording against committed blobs remain possible.

Commit-summary publishing checks require an explicit branch or remote target.

### 31.8 Unborn branch

Initialization may prepare repository files, but no initialization record exists until the first commit is created and annotated.

---

## 32. User directives

Initialization asks:

> Which Git email should identify your directives in this repository?

It stores the local preference:

```bash
git config reveries.directiveEmail user@example.com
```

The user may leave the preference unset. The initializer records that choice without writing an
empty config value. A later operation that needs `requested-by` asks before writing the source.

A materially constraining user directive is cited as:

```json
{
  "relation": "requested-by",
  "kind": "git-email",
  "ref": "user@example.com"
}
```

Rules:

* the agent never invents an address;
* if none is configured, the agent asks before writing;
* the narrative still restates the actual engineering consequence;
* normal conversation does not automatically become a source;
* only a material directive or preference receives `requested-by`.

---

## 33. Initialization workflow

`reveries-git-notes-init` performs:

1. Confirm Git worktree.
2. Inspect existing marker and notes ref.
3. Determine installation state:

   * absent;
   * healthy;
   * damaged;
   * older protocol.
4. Ask how new agents obtain the Reveries Skills: reminder only, pull when missing, vendored,
   project-local symlinks, or a pinned Git submodule.
5. Ask which hosts to support.
6. Ask which remote or remotes publish Reveries.
7. Ask which Git email identifies user directives.
8. Detect helper and adapters.
9. Show a dry-run plan.
10. Apply the selected Skill setup and edit the owned AGENTS block.
11. Add host-specific instruction adapters.
12. Configure notes merge strategy:

    ```bash
    git config notes.reveries.mergeStrategy cat_sort_uniq
    ```
13. Configure wildcard remote fetch refspecs that tolerate an unpublished notes ref.
14. Configure approved notes fetch refspecs; do not configure generic push refspecs.
15. Resolve the helper executable, then install or compose post-commit and pre-push hooks. If no
    executable is available, report partial enforcement and do not install a broken hook.
16. Run doctor. Before the adoption record exists, report a healthy `prepared` state.
17. Leave tracked files uncommitted.
18. Print:

    * fingerprinted adoption command, which commits the exact prepared paths and attaches both
      generated records to that exact commit;
    * strict-check command;
    * first atomic-push command.

The initializer is idempotent.

---

## 34. Removal

Removal preserves engineering evidence.

It:

* removes owned AGENTS content;
* removes owned Claude and Gemini adapter blocks;
* removes unchanged Skill links or copies recorded as initializer-owned;
* removes Reveries-added Git config;
* removes or unregisters Reveries hooks;
* disables project adapter activation;
* leaves `refs/notes/reveries` untouched locally and remotely.

Destructive deletion is separate and explicit:

```bash
git update-ref -d refs/notes/reveries
git push origin :refs/notes/reveries
```

The normal uninstall path never runs those commands.

---

## 35. Protocol migration

Old records are not silently rewritten.

A future reader may understand v1 and project it into a richer in-memory model.

If a future protocol cannot preserve V1 semantics safely in the same ref, migration creates a new ref rather than rewriting history:

```text
refs/notes/reveries
refs/notes/reveries-v2
```

`reveries doctor` reports:

```text
repository protocol: v1
helper reads: v1-v2
helper writes: v2
skills expect: v1-v2
migration: optional|required
```

Package version, Skill version, and protocol version are independent.

---

## 36. Release acceptance criteria

V1 is releasable only when the following pass.

### 36.1 Protocol and Git behavior

* Create reverie and read exact blob.
* Unchanged rename retains reverie.
* Identical copy resolves same reverie.
* Edited blob does not silently inherit decisions.
* Continue validates.
* Supersede validates.
* Retire validates.
* Missing disposition fails.
* Merge checks both parents.
* Forked supersession is detected.
* Supersession cycle is detected.
* Malformed JSON is inspectable but fails strict operations.
* Noncanonical JSON fails strict operations.
* Same ID with conflicting semantic content fails.
* Two clones can add independent records and merge without loss.
* Two summaries on one commit produce a conflict.
* Amend requires fresh summary.
* Rebase requires fresh summaries.
* Squash requires fresh summary.
* Cherry-pick requires fresh summary.
* Pre-init history is grandfathered.
* New published branches contain the initialization boundary.
* SHA-1 repositories generate correct IDs.
* SHA-256 repositories generate correct IDs.
* Linked worktrees share notes state and lock.
* Non-fast-forward notes push fails safely.
* Arbitrary unstaged object write is refused.

### 36.2 Initialization

* Repeated initialization is idempotent.
* Existing AGENTS prose is preserved.
* Duplicate or malformed owned markers are refused.
* Unknown hooks are not overwritten.
* Removal preserves the notes ref.
* User is queried for publishing remotes.
* Multiple remotes are supported.
* Directive email is not invented.
* Host-specific files are created only when selected.

### 36.3 Skills

* All three Skill names validate against the Agent Skills specification.
* Descriptions trigger the intended workflows.
* Init does not activate implicitly.
* Use activates for annotated-file edits and commits.
* Search activates for rationale and history questions.
* Search never mutates.
* Main Skill files remain within progressive-disclosure limits.
* Direct Git reference remains sufficient without npm helper.

### 36.4 Host adapter conformance

For every host/version claiming verified delivery:

1. Adapter inactive outside enabled repository.
2. AGENTS marker recognized.
3. Annotated read delivers causal record.
4. Several reveries remain separate.
5. Unannotated read injects nothing.
6. Repeated read deduplicated.
7. Annotated edit produces continuity reminder.
8. No network access occurs.
9. Malformed note is not trusted.
10. Control bytes are neutralized.
11. Instruction-shaped prose remains labeled as evidence.
12. Session identity captured where available.
13. Missing Git handled.
14. Detached HEAD handled.
15. Unborn branch handled.
16. Submodule behavior documented.
17. Linked worktree handled.
18. Context budget honored.
19. Uninstall removes only owned integration.
20. Known bypasses appear in compatibility matrix.

### 36.5 Installer

The Skills repository can be installed globally for:

```text
pi
claude-code
opencode
codex
gemini-cli
```

using `npx skills add`.

Update and removal paths are tested.

---

## 37. Implementation sequence

### Phase 1: Protocol

Implement:

* canonical serializer;
* schema validator;
* semantic ID generator;
* note parser;
* strict and tolerant readers;
* active reverie projection;
* source validation.

### Phase 2: Git core

Implement:

* blob resolution;
* staged and committed reads;
* notes append and replace;
* continuity graph;
* rename and successor detection;
* merge-parent analysis;
* outgoing-commit calculation;
* synchronization;
* local locking.

### Phase 3: CLI

Implement:

* `show`;
* `record`;
* `summarize`;
* `check`;
* `search`;
* `history`;
* `sync`;
* `push`;
* `doctor`;
* integration entrypoints.

### Phase 4: Skills

Write:

* three `SKILL.md` files;
* protocol references;
* direct-Git cookbook;
* writing examples;
* continuity guide;
* search guide;
* installation and troubleshooting guide.

### Phase 5: Repository initialization

Implement:

* owned block editing;
* remote questioning;
* Git config setup;
* hook composition;
* initialization boundary;
* removal.

### Phase 6: Host adapters

Implement and grade:

* Pi;
* Claude Code;
* OpenCode;
* Codex;
* Gemini CLI.

### Phase 7: Packaging

Publish:

* Skills repository for `npx skills`;
* optional npm helper;
* protocol documentation;
* compatibility matrix;
* conformance-test outputs.

---

## 38. Final V1 invariant set

The system is correct only if these invariants hold:

1. **One storage ref:** authoritative records live under `refs/notes/reveries`.
2. **Blob truth:** file reveries apply to exact blob content.
3. **Universal blob applicability:** every occurrence of the blob receives the same reveries.
4. **Causal language:** a reverie explains driving event, decision, impact, and recurrence control.
5. **Immutable decisions:** changed semantics create a new ID.
6. **Explicit continuity:** changed annotated blobs continue, supersede, or retire every active prior reverie.
7. **One commit account:** every published post-init commit has exactly one valid session summary.
8. **No inherited rewrite fiction:** rewritten commits receive fresh summaries.
9. **No silent semantic merge:** `cat_sort_uniq` resolves bytes, not decision conflicts.
10. **No empty-by-damage:** malformed evidence is not treated as absent evidence.
11. **No hidden network behavior:** automatic delivery never fetches or pushes.
12. **No proprietary authority:** Git notes remain readable and writable without the helper.
13. **No automatic evidence deletion:** uninstall preserves the notes ref.
14. **No path fiction:** paths aid provenance and navigation but do not define V1 applicability.
15. **No forced noise:** a commit needs a summary but does not need a fabricated reverie.
16. **No automatic authority:** reveries are repository evidence, not executable instructions.

---

## 39. Main point

It does not attempt to model the entire repository or coordinate an agent swarm.

It preserves one thing that source control routinely loses:

> The concrete engineering reason why an immutable piece of code has the form it has.

The file blob carries the **what**.

The reverie carries:

* the event that demanded a decision;
* the decision and its cause;
* the impact;
* the recurrence control;
* the alternatives;
* the provenance.

When the blob changes, the repository cannot honestly continue until those prior decisions have been addressed.

That continuity rule is the core of Reveries.

[1]: https://git-scm.com/docs/git-notes "Git - git-notes Documentation"
[2]: https://llis.nasa.gov/lesson/473 "Llis"
[3]: https://git-scm.com/docs/git-gc/2.42.0.html "Git - git-gc Documentation"
[4]: https://git-scm.com/docs/git-push "Git - git-push Documentation"
[5]: https://git-scm.com/docs/githooks "Git - githooks Documentation"
[6]: https://geminicli.com/docs/cli/gemini-md/ "Provide context with GEMINI.md files | Gemini CLI"
[7]: https://agentskills.io/specification "Specification - Agent Skills"
[8]: https://github.com/vercel-labs/skills "GitHub - vercel-labs/skills: The open agent skills tool - npx skills · GitHub"
