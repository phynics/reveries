import type { ActiveProjection } from "./projection.ts";
import type { BlobId, ReverieId, SessionSummary, SubjectId } from "./protocol.ts";

/**
 * A blob-only predecessor/successor pair. Kept for backward-compatible
 * callers; new tree-aware paths use `SubjectTransition`.
 */
export type BlobTransition = {
  from: BlobId;
  to?: BlobId;
};

/**
 * A blob-or-tree predecessor/successor pair (RVR-013). A byte-identical
 * move or copy needs no disposition: the same subject OID stays reachable.
 * A descendant edit produces a new ancestor tree OID and therefore an
 * explicit continuity obligation on each annotated ancestor tree.
 */
export type SubjectTransition = {
  from: SubjectId;
  to?: SubjectId;
};

export type ContinuityInput = {
  transitions: readonly SubjectTransition[];
  predecessors: ReadonlyMap<SubjectId, ActiveProjection>;
  successors: ReadonlyMap<SubjectId, ActiveProjection>;
  summary?: SessionSummary;
};

export type ContinuityDisposition =
  | { kind: "continue"; id: ReverieId; from_blob: SubjectId; to_blob: SubjectId }
  | { kind: "supersede"; old: ReverieId; replacement: ReverieId; from_blob: SubjectId; to_blob: SubjectId }
  | { kind: "retire"; id: ReverieId; from_blob: SubjectId; reason: string };

export type ContinuityObligation = {
  id: ReverieId;
  from_blob: SubjectId;
  to_blob?: SubjectId;
  reason: "missing-disposition" | "ambiguous-disposition";
};

export type ContinuityReport = {
  ok: boolean;
  dispositions: ContinuityDisposition[];
  obligations: ContinuityObligation[];
  conflicts: string[];
};

function retirementsFor(summary: SessionSummary | undefined, id: ReverieId, from: SubjectId) {
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
      conflicts.push(`predecessor subject ${transition.from} has an invalid reverie projection`);
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
