import { adaptHostEvent, type HookEvent } from "../src/hooks.ts";

export const capabilityGrade = "CORE" as const;

export function adaptClaudeCodeEvent(input: unknown, session?: string | null): HookEvent {
  return adaptHostEvent("claude", input, session);
}
