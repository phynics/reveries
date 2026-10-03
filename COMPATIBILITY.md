# Host compatibility

The neutral hook contract is implemented in `packages/reveries/src/hooks.ts`. Host files only translate native event envelopes; they do not parse Reveries records or perform Git operations.

| Host | Tested version | Grade | Verified events | Known bypasses | Session identity |
| --- | --- | --- | --- | --- | --- |
| Pi | 0.84.1 | CORE | Skill routing and read-only rationale search; no adapter event claimed | native automatic delivery not verified | forwarded when supplied |
| Claude Code | contract fixture only | CORE | none claimed | native Claude Code wiring not verified | forwarded when supplied |
| OpenCode | contract fixture only | CORE | none claimed | native OpenCode wiring not verified | forwarded when supplied |
| Codex | contract fixture only | CORE | none claimed | native Codex wiring not verified | forwarded when supplied |
| Gemini CLI | contract fixture only | CORE | none claimed | native Gemini CLI wiring not verified | forwarded when supplied |

CORE means Skills, project instructions, direct Git operations, and manual maintenance are supported. Pi 0.84.1 has recorded Skill-routing and no-mutation search evidence in `evidence/pi-skills.json`. Automatic delivery is not claimed as verified for any host version until the complete native adapter conformance suite passes.

## Evidence privacy compatibility

Record creation rejects common credential patterns before it appends a note. The scanner is
best-effort and cannot prove that evidence is secret-free; review evidence before recording it.
Reveries-managed publication checks the complete notes snapshot, including soft-redacted records,
and refuses likely secrets. A redaction does not make secret bytes safe to publish.

Normal search and automatic model delivery omit soft-redacted targets. The history API keeps the
original records so it can report immutable history; callers that render history must honor its
redaction facts. Automatic delivery verifies redaction identities before filtering and omits opaque
confidential-pointer values.

`reveries redact hard` rewrites the canonical notes ref as a new root snapshot without the named facts,
moves the ledger branch to a new genesis checkpoint, deletes the local retention refs and the stale
remote-tracking and quarantine refs in one ref transaction, and reports the remote-side follow-up for
every configured remote. Refs outside that known set are left to their owner. The command never
contacts a remote and always states that deletion from independent copies is not guaranteed.
Repeating the same redaction converges instead of rewriting again.

Existing V1 records and source kinds keep their wire shape. The new `confidential-pointer` source
kind uses `vault:v1:<43-character-base64url-id>` and is additive. Strict readers that do not recognize
that kind reject pointer-bearing records, so repositories must upgrade strict readers before they
publish one. A pointer is not rationale or an access token. It may appear only in an ID-bearing
record with a signature over that record. A consumer may rely on its private rationale only after
it verifies a trusted signature. Signature trust stores remain local and are not copied by clone or
notes transport.

## Receive boundaries

| Boundary | Adapter | Contract | Bypass control |
| --- | --- | --- | --- |
| GHES | `packages/reveries/adapters/ghes-pre-receive.sh` | Git pre-receive `old new ref` stream | Nonzero exit before ref movement |
| GitHub.com | `.github/workflows/reveries-receive-check.yml` | `pull_request_target` | Branch protection requires the App-owned check in `.github/reveries-required-check.json` |
| Fork pull request | `.github/workflows/reveries-evidence-import.yml` | `pull_request_target` notes import | Fork code is not executed by the importer |
| Post-merge summaries | `.github/workflows/reveries-post-merge.yml` | `push` to the default branch | Runs only the protected default-branch revision; pull request commits are fetched as Git data |
| V1 merge bot | `.github/workflows/reveries-controlled-merge.yml` | `workflow_run` from the trusted receive-check; its exact source-run artifact; strict default-branch ruleset; `reveries-merge` protected environment | **Hard-disabled and no write permission.** The workflow has no ref selector and consumes the exact successful base-branch `pull_request_target` run, but `MERGE_ENABLED=false` and the token has no `pull-requests: write` until independent review passes and administrators configure strict required checks plus required reviewers/protected-branch policy on the environment |

Hosted behavior remains a deployment contract. The required check is posted by the **GitHub
Actions App** (`github-actions`, ID `15368`), because the check runs from a workflow in this
repository; an earlier revision named a `reveries` App that no installation provides, which made
the pin permanently unsatisfiable rather than strict. Pin the exact check from that App in branch
protection.

Overriding the identity is one control, not two. Setting the `REVERIES_REQUIRED_APP_SLUG` and
`REVERIES_REQUIRED_APP_ID` repository variables changes what the merge bot trusts, and branch
protection must be changed to require the same App in the same step. A bot trusting App A while
the ruleset requires App B checks nothing, and a ruleset requiring App B while the bot trusts
App A means the bot's gate is not the repository's gate.
