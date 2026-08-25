import { adaptHostEvent, type HookEvent } from "../src/hooks.ts";

export const capabilityGrade = "CORE" as const;

export function adaptPiEvent(input: unknown, session?: string | null): HookEvent {
  return adaptHostEvent("pi", input, session);
}
