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
| GitHub.com | `.github/workflows/reveries-receive-check.yml` | `pull_request` and `merge_group` | Branch protection requires the App-owned check in `.github/reveries-required-check.json` |
| Fork pull request | `.github/workflows/reveries-evidence-import.yml` | `pull_request_target` notes import | Fork code is not executed by the importer |
| V1 merge bot | `.github/workflows/reveries-controlled-merge.yml` | App-owned check plus base-tree OID | Merge is refused when the base tree changes |

Hosted behavior remains a deployment contract: install the App, configure its numeric ID in
`REVERIES_APP_ID`, and pin the exact check in branch protection.
