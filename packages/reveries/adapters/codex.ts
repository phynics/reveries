import { adaptHostEvent, type HookEvent } from "../src/hooks.ts";

export const capabilityGrade = "CORE" as const;

export function adaptCodexEvent(input: unknown, session?: string | null): HookEvent {
  return adaptHostEvent("codex", input, session);
}
