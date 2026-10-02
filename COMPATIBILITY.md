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
