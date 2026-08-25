import type { ActiveProjection } from "./projection.ts";
import type { BlobId, ReverieId, SessionSummary } from "./protocol.ts";

export type BlobTransition = {
  from: BlobId;
  to?: BlobId;
};

export type ContinuityInput = {
  transitions: readonly BlobTransition[];
  predecessors: ReadonlyMap<BlobId, ActiveProjection>;
  successors: ReadonlyMap<BlobId, ActiveProjection>;
  summary?: SessionSummary;
};

export type ContinuityDisposition =
  | { kind: "continue"; id: ReverieId; from_blob: BlobId; to_blob: BlobId }
  | { kind: "supersede"; old: ReverieId; replacement: ReverieId; from_blob: BlobId; to_blob: BlobId }
  | { kind: "retire"; id: ReverieId; from_blob: BlobId; reason: string };

export type ContinuityObligation = {
  id: ReverieId;
  from_blob: BlobId;
  to_blob?: BlobId;
  reason: "missing-disposition" | "ambiguous-disposition";
};

export type ContinuityReport = {
  ok: boolean;
  dispositions: ContinuityDisposition[];
  obligations: ContinuityObligation[];
  conflicts: string[];
};

function retirementsFor(summary: SessionSummary | undefined, id: ReverieId, from: BlobId) {
  return summary?.entries.flatMap((entry) => entry.retirements)
    .filter((retirement) => retirement.reverie === id && retirement.from_blob === from) ?? [];
}

export function analyzeContinuity(input: ContinuityInput): ContinuityReport {
  const dispositions: ContinuityDisposition[] = [];
  const obligations: ContinuityObligation[] = [];
  const conflicts: string[] = [];
  const seenTransitions = new Set<string>();

  for (const transition of input.transitions) {
    const transitionKey = `${transition.from}:${transition.to ?? "deleted"}`;
    if (seenTransitions.has(transitionKey)) continue;
    seenTransitions.add(transitionKey);
    const predecessor = input.predecessors.get(transition.from);
    if (!predecessor) continue;
    if (predecessor.cycles.length > 0 || predecessor.forks.length > 0 || (predecessor.conflicts?.length ?? 0) > 0) {
      conflicts.push(`predecessor blob ${transition.from} has an invalid reverie projection`);
    }
    const successor = transition.to === undefined ? undefined : input.successors.get(transition.to);
    for (const old of predecessor.active) {
      const retirements = retirementsFor(input.summary, old.id, transition.from);
      const continued = successor?.active.filter((candidate) => candidate.id === old.id) ?? [];
      const replacements = successor?.active.filter((candidate) => candidate.id !== old.id && candidate.supersedes.includes(old.id)) ?? [];
      const choices = Number(continued.length > 0) + Number(replacements.length > 0) + Number(retirements.length > 0);
      if (choices !== 1) {
        obligations.push({
          id: old.id,
          from_blob: transition.from,
          ...(transition.to === undefined ? {} : { to_blob: transition.to }),
          reason: choices === 0 ? "missing-disposition" : "ambiguous-disposition",
        });
        continue;
      }
      if (continued.length > 0 && transition.to !== undefined) {
        dispositions.push({ kind: "continue", id: old.id, from_blob: transition.from, to_blob: transition.to });
      } else if (replacements.length > 0 && transition.to !== undefined) {
        if (replacements.length > 1) {
          obligations.push({ id: old.id, from_blob: transition.from, to_blob: transition.to, reason: "ambiguous-disposition" });
          continue;
        }
        dispositions.push({ kind: "supersede", old: old.id, replacement: replacements[0]!.id, from_blob: transition.from, to_blob: transition.to });
      } else {
        const reason = retirements[0]?.reason.trim() ?? "";
        if (!reason || /^(?:n\/a|none|no longer needed|tests pass)\.?$/i.test(reason)) {
          obligations.push({ id: old.id, from_blob: transition.from, reason: "ambiguous-disposition" });
          continue;
        }
        dispositions.push({ kind: "retire", id: old.id, from_blob: transition.from, reason });
      }
    }
  }

  return { ok: obligations.length === 0 && conflicts.length === 0, dispositions, obligations, conflicts };
}
