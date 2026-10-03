import type { ActiveProjection } from "./projection.ts";
import type { BlobId, LineageId, ReverieId, SessionSummary, SubjectId } from "./protocol.ts";

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

/**
 * One predecessor subject and the complete set of successors it became
 * (RVR-014). The set is what makes an N-to-M relation expressible: an
 * occurrence that split into three successors carries all three here, and
 * each one is then judged on its own evidence.
 *
 * The pairing carries no decisions. It says which subjects are related; it
 * discharges nothing, so a lineage edge can never stand in for a
 * continuation, a supersession, or a retirement.
 */
export type SubjectPairing = {
  from: SubjectId;
  /** Ordered by subject ID so reports and comparisons stay deterministic. */
  to: readonly SubjectId[];
  /** The lineage edge that established this successor set, when one did. */
  lineage?: LineageId;
};

export type ContinuityInput = {
  /** Legacy one-to-one pairs (V1, RVR-013); normalized into `pairings`. */
  transitions?: readonly SubjectTransition[];
  /** Pairings with a full successor set (RVR-014). */
  pairings?: readonly SubjectPairing[];
  predecessors: ReadonlyMap<SubjectId, ActiveProjection>;
  successors: ReadonlyMap<SubjectId, ActiveProjection>;
  summary?: SessionSummary;
};

/**
 * One decision discharged at one successor endpoint.
 *
 * `to_blob` is the endpoint it was discharged at, so a split that continues
 * in one half and supersedes in the other produces two dispositions for the
 * same decision rather than one merged verdict. `lineage` names the edge that
 * established the successor set, which is provenance for the disposition
 * rather than a disposition of its own.
 */
export type ContinuityDisposition =
  | {
    kind: "continue";
    id: ReverieId;
    from_blob: SubjectId;
    to_blob: SubjectId;
    lineage?: LineageId;
  }
  | {
    kind: "supersede";
    old: ReverieId;
    replacement: ReverieId;
    from_blob: SubjectId;
    to_blob: SubjectId;
    lineage?: LineageId;
  }
  | { kind: "retire"; id: ReverieId; from_blob: SubjectId; reason: string };

export type ContinuityObligation = {
  id: ReverieId;
  from_blob: SubjectId;
  /**
   * The successor endpoints that still need their own disposition. Absent when
   * the pairing has no successors at all, which is the deletion case: only a
   * causal retirement can clear it.
   */
  to_blob?: SubjectId;
  /** Every endpoint that still lacks evidence, sorted, for the diagnostic. */
  missing_at?: readonly SubjectId[];
  reason: "missing-disposition" | "ambiguous-disposition" | "ambiguous-pairing";
};

/** Why a predecessor's successor set could not be accepted, if it could not. */
export type PairingConflict = {
  from: SubjectId;
  reason: "ambiguous-pairing" | "contradictory-lineage";
  detail: string;
  lineage?: LineageId;
};

export type ContinuityReport = {
  ok: boolean;
  dispositions: ContinuityDisposition[];
  obligations: ContinuityObligation[];
  conflicts: string[];
  /** Pairings refused because their claim contradicted the checked change. */
  pairingConflicts: PairingConflict[];
};

function retirementsFor(summary: SessionSummary | undefined, id: ReverieId, from: SubjectId) {
  return summary?.entries.flatMap((entry) => entry.retirements)
    .filter((retirement) => retirement.reverie === id && retirement.from_blob === from) ?? [];
}

function subjectSort(left: SubjectId, right: SubjectId): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Collapse both input forms into one list of successor sets, and refuse a
 * predecessor that arrives twice with *different* successor sets.
 *
 * Two claims about one predecessor are a contradiction, not a preference: a
 * same-path identity pairing plus a lineage edge, or two lineage edges, would
 * otherwise let whichever one is read first decide the outcome. An empty set is
 * not a claim — it only says no successor was identified — so it merges with a
 * real set instead of conflicting with it, which is what lets a rename with no
 * same-path successor be paired by an edge.
 */
function resolvePairings(input: ContinuityInput): {
  readonly pairings: readonly SubjectPairing[];
  readonly conflicts: PairingConflict[];
} {
  /**
   * Per predecessor, one claim per *source*. `legacy` accumulates successor
   * sets inferred from identity (same-path pairing); `edges` holds the causal
   * claims, keyed by lineage ID so an exact duplicate can be recognized.
   */
  type Claim = {
    legacy: SubjectId[];
    edges: Map<LineageId, SubjectId[]>;
  };
  const claims = new Map<SubjectId, Claim>();
  const conflicts: PairingConflict[] = [];

  const note = (from: SubjectId, to: readonly SubjectId[], lineage: LineageId | undefined): void => {
    const claim = claims.get(from) ?? { legacy: [], edges: new Map<LineageId, SubjectId[]>() };
    claims.set(from, claim);
    const successors = [...to].sort(subjectSort);

    // An identity pair with no successor is not a claim: it only says no
    // successor was identified, so a real pairing may still describe the
    // predecessor. That heuristic is what lets a renamed-and-edited subject be
    // paired by an edge instead of conflicting with the empty pair.
    if (lineage === undefined) {
      claim.legacy = [...new Set([...claim.legacy, ...successors])].sort(subjectSort);
      return;
    }
    // The same record twice is idempotence, not a second claim.
    if (claim.edges.has(lineage)) return;

    if (claim.edges.size > 0) {
      // Two distinct edges are two causal claims about one predecessor. Equal
      // endpoint sets do not make them agree: the reasoning differs, so the
      // choice between them is exactly what fail-closed exists for.
      const all = [...claim.edges.keys(), lineage].sort();
      conflicts.push({
        from,
        reason: "ambiguous-pairing",
        detail: `the predecessor is paired by ${all.join(" and ")}, and two causal claims cannot both be authoritative`,
        lineage,
      });
    } else if (claim.legacy.length > 0) {
      // A successor set comes from exactly one source. Identity and lineage are
      // different sources, so they conflict even when they name the same
      // subjects: agreeing by accident is not an agreement anyone asserted.
      conflicts.push({
        from,
        reason: "ambiguous-pairing",
        detail: `the predecessor is paired by same-path identity and by lineage ${lineage}; the successor set must come from one source`,
        lineage,
      });
    }
    claim.edges.set(lineage, successors);
  };

  for (const transition of input.transitions ?? []) {
    note(transition.from, transition.to === undefined ? [] : [transition.to], undefined);
  }
  for (const pairing of input.pairings ?? []) {
    note(pairing.from, pairing.to, pairing.lineage);
  }

  const pairings: SubjectPairing[] = [...claims.entries()].map(([from, claim]) => {
    const ids = [...claim.edges.keys()].sort();
    const to = [...new Set([...claim.legacy, ...ids.flatMap((id) => claim.edges.get(id) ?? [])])]
      .sort(subjectSort);
    return {
      from,
      to,
      ...(ids.length === 0 ? {} : { lineage: ids[0] as LineageId }),
    };
  });
  return { pairings, conflicts };
}

export function analyzeContinuity(input: ContinuityInput): ContinuityReport {
  const dispositions: ContinuityDisposition[] = [];
  const obligations: ContinuityObligation[] = [];
  const conflicts: string[] = [];
  const { pairings, conflicts: pairingConflicts } = resolvePairings(input);
  for (const conflict of pairingConflicts) {
    conflicts.push(`subject ${conflict.from} has ${conflict.reason}: ${conflict.detail}`);
  }

  for (const pairing of pairings) {
    const predecessors = input.predecessors.get(pairing.from);
    if (!predecessors) continue;
    if (predecessors.cycles.length > 0 || predecessors.forks.length > 0 || (predecessors.conflicts?.length ?? 0) > 0) {
      conflicts.push(`predecessor subject ${pairing.from} has an invalid reverie projection`);
    }
    for (const old of predecessors.active) {
      const retired = retirementsFor(input.summary, old.id, pairing.from);
      // Per-endpoint evidence: one successor's record can never stand in for
      // another's, so an N-to-M pairing owes the decision N independent
      // dispositions instead of one verdict about the set.
      const carried: SubjectId[] = [];
      const replaced: { subject: SubjectId; replacements: ReverieId[] }[] = [];
      for (const successor of pairing.to) {
        const projection = input.successors.get(successor);
        if (projection === undefined) continue;
        const continued = projection.active.filter((candidate) => candidate.id === old.id);
        const replacements = projection.active.filter((candidate) => candidate.supersedes.includes(old.id));
        if (continued.length > 0) carried.push(successor);
        if (replacements.length > 0) replaced.push({ subject: successor, replacements: replacements.map((entry) => entry.id) });
      }
      if (retired.length > 0) {
        // A retirement releases the decision at its predecessor, so a successor
        // that still carries it (or its replacement) is a contradiction rather
        // than extra evidence.
        if (carried.length > 0 || replaced.length > 0) {
          obligations.push({
            id: old.id,
            from_blob: pairing.from,
            ...(pairing.to.length === 1 && pairing.to[0] !== undefined ? { to_blob: pairing.to[0] } : {}),
            reason: "ambiguous-disposition",
          });
          continue;
        }
        const reason = retired[0]?.reason.trim() ?? "";
        if (!reason || /^(?:n\/a|none|no longer needed|tests pass)\.?$/i.test(reason)) {
          obligations.push({ id: old.id, from_blob: pairing.from, reason: "ambiguous-disposition" });
          continue;
        }
        dispositions.push({ kind: "retire", id: old.id, from_blob: pairing.from, reason });
        continue;
      }

      // No successor at all: a vanished path, a deleted subject, or a retire
      // edge. Nothing can carry the decision forward, so only a causal
      // retirement clears it, and a bare pairing clears nothing.
      if (pairing.to.length === 0) {
        obligations.push({ id: old.id, from_blob: pairing.from, reason: "missing-disposition" });
        continue;
      }

      // Exactly one disposition per successor endpoint. An endpoint that both
      // continues the decision and replaces it, or that replaces it twice, is
      // ambiguous; an endpoint with neither is missing. Both are reported
      // separately, and a satisfied endpoint still records its own disposition,
      // so a report shows precisely which successors are unfinished.
      let unresolved = false;
      for (const successor of pairing.to) {
        const continued = carried.includes(successor);
        const replacements = replaced.find((entry) => entry.subject === successor)?.replacements ?? [];
        // The obligation always names the one successor it is about, so a
        // multi-endpoint pairing still reports precisely which one is unfinished.
        const single = { to_blob: successor };
        const lineage = pairing.lineage === undefined ? {} : { lineage: pairing.lineage };
        if (continued && replacements.length > 0) {
          obligations.push({ id: old.id, from_blob: pairing.from, ...single, reason: "ambiguous-disposition" });
          unresolved = true;
          continue;
        }
        if (replacements.length > 1) {
          obligations.push({ id: old.id, from_blob: pairing.from, ...single, reason: "ambiguous-disposition" });
          unresolved = true;
          continue;
        }
        if (continued) {
          dispositions.push({ kind: "continue", id: old.id, from_blob: pairing.from, to_blob: successor, ...lineage });
          continue;
        }
        if (replacements.length === 1) {
          dispositions.push({
            kind: "supersede",
            old: old.id,
            replacement: replacements[0] as ReverieId,
            from_blob: pairing.from,
            to_blob: successor,
            ...lineage,
          });
          continue;
        }
        obligations.push({
          id: old.id,
          from_blob: pairing.from,
          ...single,
          missing_at: [successor],
          reason: "missing-disposition",
        });
        unresolved = true;
      }
      if (unresolved) continue;
    }
  }

  return {
    ok: obligations.length === 0 && conflicts.length === 0,
    dispositions,
    obligations,
    conflicts,
    pairingConflicts,
  };
}
