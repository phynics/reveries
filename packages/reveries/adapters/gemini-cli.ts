import { adaptHostEvent, type HookEvent } from "../src/hooks.ts";

export const capabilityGrade = "CORE" as const;

export function adaptGeminiCliEvent(input: unknown, session?: string | null): HookEvent {
  return adaptHostEvent("gemini", input, session);
}
