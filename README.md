# Reveries

[![CI](https://github.com/phynics/reveries/actions/workflows/ci.yml/badge.svg)](https://github.com/phynics/reveries/actions/workflows/ci.yml)

Reveries preserves the causal engineering record that source control usually loses. It stores
immutable decisions as Git notes attached to exact blobs and attaches one causal session summary
to each published post-adoption commit.

The protocol is `reveries/v1`; its only authoritative storage ref is
`refs/notes/reveries`. The helper is optional: all evidence remains ordinary JSONL in Git notes.

## What it guarantees

- A file reverie applies to a blob, so unchanged renames and copies retain it, and an edit cannot
  silently inherit it.
- An annotated blob change must explicitly continue, supersede, or retire every active decision.
- Each published commit after the adoption boundary has one session summary.
- A note is repository evidence, not executable authority and not proof that an assertion is true.

Reveries deliberately does not manage work, permissions, architecture graphs, or issue systems.
The optional receive boundary and hosted adapters enforce evidence at Git and hosted merge
boundaries; they do not make evidence executable authority.

## Quick start

Install the Skills, then explicitly initialize a repository with
`reveries-git-notes-init`. Initialization asks how agents obtain the Skills, which hosts to
configure, which remotes publish the notes, and which email identifies material directives.
Local-only setup, no host adapters, and no directive email are valid choices. The initializer
does not create the adoption commit or push.

```bash
npx skills add https://github.com/phynics/reveries --global \
  --agent pi --agent claude-code --agent opencode --agent codex --agent gemini-cli \
  --skill reveries-git-notes-init \
  --skill using-reveries \
  --skill reveries-git-notes-search
```

The initializer asks how future agents should obtain the Reveries Skills: rely on an existing
installation, pull them from an approved repository, commit pinned copies, expose tracked
project Skills through relative symlinks, or add the full Reveries repository as a pinned Git
submodule at `.agents/reveries`. Submodules keep reviewed revisions reproducible, but require
the usual Git submodule checkout step on fresh clones. The Skills and direct Git fallback do not
require the helper. After adoption, publish with `reveries push <remote>`. Do not use a generic
multi-ref `git push`: only the helper verifies and requests an atomic branch-plus-notes update.

### Adopt without the helper

When the helper is unavailable, follow the [Git-only manual setup guide](skills/reveries-git-notes-init/references/manual-setup.md).
It creates the same tracked instruction blocks and adoption records. After the helper is available,
run `reveries init` with the same answers to install local hooks without rewriting tracked setup.
Git-only setup does not provide strict checking or atomic publication.

### Repair a fresh clone

A clone never receives local integration: the notes refspec, merge strategy, helper runner, and
the `pre-push` and `post-commit` hooks all live in `.git/`. Fetch the committed evidence, then
repair the local state:

```bash
git fetch origin '+refs/notes/reveries*:refs/notes/reveries*'
reveries sync origin --pull
reveries doctor --fix
```

`reveries doctor --fix` reads the committed `reveries-init` record for the approved publishing
remotes and converges only local Git configuration, the managed notes refspec, the helper runner,
and Reveries-owned hook blocks. It never writes tracked files, never appends or rewrites notes,
and never creates or changes an adoption plan, so it is safe to run on a clone of a repository
that was already adopted. Running it twice is a no-op.

Repair preserves hooks it does not own. An unknown hook or an edited owned block is left intact
and reported as partial enforcement, and a repository whose hooks are redirected by
`core.hooksPath` is reported as an unsupported hook manager instead of being written to
elsewhere. Both cases print the exact command to add by hand. `reveries doctor` without `--fix`
only reports.

Build and run the helper from this repository:

```bash
npm install
npm run build
node packages/reveries/dist/src/main.js --help
```

Run the strict release evaluation:

```bash
npm run verify
```

The [local evaluation guide](EVALUATION.md) explains the executable matrix, recorded Pi evidence,
and the boundary of the automatic-delivery claim.

The helper implements `init`, `adopt`, `doctor`, `show`, `record`, `summarize`, `check`,
`receive-check`, `search`, `history`, `sync`, `ledger`, `role`, `policy`, `sign`, `verify`,
`trust`, `push`, and the hook entrypoints. Inspection and
check commands accept `--json` for stable machine output. See
[hosted enforcement](HOSTED_ENFORCEMENT.md) for the GHES hook, GitHub workflows, fork evidence
import, and controlled merge bot.

Create decisions from a partial JSON draft or directly from command-line fields:

```bash
cat > reverie.json <<'JSON'
{
  "driving_event": "Two callers can race to update the same state.",
  "decision": "Use one guarded mutation boundary.",
  "impact": "Every state transition passes through the guard."
}
JSON

reveries record new src/state.ts --from reverie.json \
  --alternative "Keep independent mutation paths" \
  --source implements:issue:github:owner/repository#32

cat > summary.json <<'JSON'
{
  "entries": [{
    "driving_event": "A transition exposed two writers.",
    "decision": "Keep one guarded mutation boundary.",
    "impact": "All writers use the same transition check."
  }]
}
JSON

cat summary.json | reveries summarize HEAD --from -
reveries summarize HEAD --from summary.json --edit

# Supply causal fields without a draft file.
reveries record new src/state.ts \
  --driving-event "A state transition must be auditable." \
  --decision "Attach its rationale to the blob." \
  --impact "Future readers can inspect the decision."

# Replace the placeholders with full reverie, blob, and commit IDs.
reveries summarize HEAD \
  --driving-event "A prior decision no longer applies." \
  --decision "Retire the old reverie with a replacement." \
  --impact "The new summary links both decisions." \
  --no-recurrence-control \
  --reverie 'rv:<reverie-id>' \
  --retire 'rv:<reverie-id>:<blob-id>:The source changed: use the new boundary.'
```

The CLI fills missing author, timestamp, and session metadata from Git configuration, the current
UTC time, and `--session` or `REVERIES_SESSION`. For `push` and `sync`, Reveries uses the current
branch's upstream or the sole configured publishing remote. Pass a remote explicitly when those
settings are ambiguous:

```bash
reveries sync --status
reveries sync --pull
reveries push
reveries push origin
```

## Signing, trust, and authority

A signature says who holds a key; a record says who typed an email address. Keeping them
separate is what makes key rotation harmless. The trust store binds a public key to the identity
it may speak for, and it lives in the Git common directory by default, so no clone receives it
and a trust decision stays local while the evidence it judges travels.

```bash
reveries trust init --signer me@example.com --key-file ~/.config/reveries/signing.pem
reveries trust add  --signer me@example.com --from-file ~/.config/reveries/reveries.pub.pem
reveries role set origin primary
reveries policy set author,reviewer
reveries sign rv:<reverie-id>
reveries verify
reveries ledger build
```

`trust add` takes a **PEM public** key. An OpenSSH `ssh-ed25519 AAAA...` line is refused by name
rather than stored as something the verifier could never use.

`trust init` is the only key-generation path and runs only when you ask for it. It writes the
private key exclusively, with mode `0600`, never overwriting an existing file, and refuses a path
inside the worktree or either Git directory — checked on the real path, so a relative path, a
`..` segment, and a symlinked parent all resolve to the same answer. Only the location is ever
reported; no key material reaches output, `--json`, or a diagnostic.

`verify` reports every trust state at face value and fails only for `invalid` and `revoked`.
`--require-policy` is the stricter question: it fails for every state below `policy-satisfying`,
including a repository with no signatures. `--ledger` verifies the checkpoint envelope and reports
its manifest attestation.

A signature attests the protocol domain, role, target, subject, signer, algorithm, and the
target's content hash. The signature record's own `author_email`, `session`, and `created_at` lie
outside both that payload and its `sg:` ID, so they are unclaimed rather than attested and the
CLI never presents them as though they were.

For day-to-day changes, use `using-reveries`:

```text
inspect blob evidence → edit → stage → reconcile continuity → commit
→ summarize the commit → strict check → synchronize → `reveries push <remote>`
```

For rationale questions, use `reveries-git-notes-search`. It is read-only and starts from the
current revision unless historical evidence is requested.

## Direct Git fallback

```bash
blob="$(git rev-parse 'HEAD:src/state.rs')"
git notes --ref=refs/notes/reveries show "$blob"

git notes --ref=refs/notes/reveries list
git log -p refs/notes/reveries
```

Use `git notes --ref=refs/notes/reveries` explicitly; Reveries never changes `core.notesRef`.
The Skills include safe writing, synchronization, and recovery commands.

When the helper is unavailable, the lower-grade evidence-first fallback is two separate pushes:

```bash
git push origin refs/notes/reveries:refs/notes/reveries
git push --no-verify origin HEAD
```

Push the notes first and push code only after the evidence succeeds. This ordering avoids publishing
code before its evidence, but it is not atomic and cannot prevent a later code push from being made
without the notes. The second command uses `--no-verify` because the Reveries pre-push hook rejects
raw branch publication. The flag skips the entire configured pre-push hook, including unrelated
checks. Inspect the hook first. Run any other required checks separately, or do not use this fallback.
Local hooks are accidental-bypass protection, not a security boundary. Configure receive-side
checks for a stronger boundary.

## Protocol documentation

- [Approved V1 design](DESIGN.md)
- [Roadmap and V2 evidence model](ROADMAP.md)
- [Detailed ticket specifications](docs/tickets.md)
- [V1 protocol](protocol/v1.md)
- [Reverie schema](protocol/schemas/reverie.schema.json)
- [Session-summary schema](protocol/schemas/session-summary.schema.json)
- [Initialization-record schema](protocol/schemas/reveries-init.schema.json)

## Compatibility

| Host | Grade | Automatic delivery |
| --- | --- | --- |
| Pi | CORE | Not yet verified |
| Claude Code | CORE | Not yet verified |
| OpenCode | CORE | Not yet verified |
| Codex | CORE | Not yet verified |
| Gemini CLI | CORE | Not yet verified |

`CORE` means project instructions, Skills, direct Git inspection, and manual maintenance work.
It does not claim an automatic read/edit adapter has passed a host-version conformance suite.

## Status

Reveries V1.0.2 implements the protocol, Git core, CLI, Skills, host-neutral hook contract, and
conservative host adapters. The release gate covers 46 claimed acceptance criteria; automatic
delivery remains explicitly unclaimed. Every host stays at `CORE` until a named host version
passes the native automatic-delivery conformance suite.
