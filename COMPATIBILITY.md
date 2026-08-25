# Host compatibility

The neutral hook contract is implemented in `packages/reveries/src/hooks.ts`. Host files only translate native event envelopes; they do not parse Reveries records or perform Git operations.

| Host | Tested version | Grade | Verified events | Known bypasses | Session identity |
| --- | --- | --- | --- | --- | --- |
| Pi | contract fixture only | CORE | none claimed | native Pi wiring not verified | forwarded when supplied |
| Claude Code | contract fixture only | CORE | none claimed | native Claude Code wiring not verified | forwarded when supplied |
| OpenCode | contract fixture only | CORE | none claimed | native OpenCode wiring not verified | forwarded when supplied |
| Codex | contract fixture only | CORE | none claimed | native Codex wiring not verified | forwarded when supplied |
| Gemini CLI | contract fixture only | CORE | none claimed | native Gemini CLI wiring not verified | forwarded when supplied |

CORE means Skills, project instructions, direct Git operations, and manual maintenance are supported. Automatic delivery is not claimed as verified for any host version until a native conformance fixture exists.
