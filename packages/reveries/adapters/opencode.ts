import { adaptHostEvent, type HookEvent } from "../src/hooks.ts";

export const capabilityGrade = "CORE" as const;

export function adaptOpenCodeEvent(input: unknown, session?: string | null): HookEvent {
  return adaptHostEvent("opencode", input, session);
}
