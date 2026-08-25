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
