import type {
  CommitId,
  ObjectId,
  PublicationAttestation,
  ReverieId,
  ReverieRecord,
  TransitionSummary,
} from "./protocol.ts";

export type ActiveProjection = {
  active: ReverieRecord[];
  historical: ReverieRecord[];
  duplicates: ReverieId[];
  forks: ReverieId[][];
  cycles: ReverieId[][];
  conflicts?: ReverieId[];
};

function semanticKey(record: ReverieRecord): string {
  return JSON.stringify({
    v: record.v,
    driving_event: record.driving_event,
    decision: record.decision,
    impact: record.impact,
    recurrence_control: record.recurrence_control,
    alternatives: record.alternatives,
    sources: record.sources,
    supersedes: record.supersedes,
  });
}

export function projectActiveReveries(records: readonly ReverieRecord[]): ActiveProjection {
  const byId = new Map<ReverieId, ReverieRecord>();
  const duplicateIds = new Set<ReverieId>();
  const conflictIds = new Set<ReverieId>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (existing === undefined) {
      byId.set(record.id, record);
      continue;
    }
    if (semanticKey(existing) === semanticKey(record)) duplicateIds.add(record.id);
    else conflictIds.add(record.id);
  }

  const children = new Map<ReverieId, ReverieId[]>();
  const superseded = new Set<ReverieId>();
  for (const record of byId.values()) {
    for (const predecessor of record.supersedes) {
      superseded.add(predecessor);
      const list = children.get(predecessor) ?? [];
      list.push(record.id);
      children.set(predecessor, list);
    }
  }

  const active = [...byId.values()]
    .filter((record) => !superseded.has(record.id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const historical = [...byId.values()]
    .filter((record) => superseded.has(record.id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const forks: ReverieId[][] = [];
  for (const predecessor of children.keys()) {
    const terminals = new Set<ReverieId>();
    const visitedDescendants = new Set<ReverieId>();
    const collectTerminals = (id: ReverieId): void => {
      if (visitedDescendants.has(id)) return;
      visitedDescendants.add(id);
      const descendants = children.get(id) ?? [];
      if (descendants.length === 0) {
        terminals.add(id);
        return;
      }
      for (const descendant of descendants) collectTerminals(descendant);
    };
    for (const child of children.get(predecessor) ?? []) collectTerminals(child);
    if (terminals.size > 1) forks.push([predecessor, ...[...terminals].sort()]);
  }

  const cycles: ReverieId[][] = [];
  const visited = new Set<ReverieId>();
  const activePath = new Map<ReverieId, number>();
  const walk = (id: ReverieId, path: ReverieId[]): void => {
    const position = activePath.get(id);
    if (position !== undefined) {
      cycles.push(path.slice(position).concat(id));
      return;
    }
    if (visited.has(id)) return;
    const record = byId.get(id);
    if (record === undefined) {
      visited.add(id);
      return;
    }
    activePath.set(id, path.length);
    for (const predecessor of record.supersedes) walk(predecessor, [...path, id]);
    activePath.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) walk(id, []);

  return {
    active,
    historical,
    duplicates: [...duplicateIds].sort(),
    forks,
    cycles,
    ...(conflictIds.size === 0 ? {} : { conflicts: [...conflictIds].sort() }),
  };
}

export type TransitionAttestationProjection = {
  transition: TransitionSummary | null;
  diagnostics: string[];
};

/**
 * Link a published commit to its reviewed tree transition through its
 * publication attestation. Pure: callers resolve the commit's parent trees,
 * result tree, attestations, and candidate transition records first.
 * Exactly one attested transition whose stored trees match the resolved
 * trees resolves; anything else fails closed with a diagnostic.
 */
export function projectTransitionAttestation(input: {
  commit: CommitId;
  parents: readonly ObjectId[];
  result: ObjectId;
  attestations: readonly PublicationAttestation[];
  transitions: readonly TransitionSummary[];
}): TransitionAttestationProjection {
  const mine = input.attestations.filter((attestation) => attestation.commit === input.commit);
  if (mine.length === 0) {
    return {
      transition: null,
      diagnostics: [`Commit ${input.commit} has no publication attestation`],
    };
  }
  const attested = [...new Set(mine.map((attestation) => attestation.transition))].sort();
  if (attested.length > 1) {
    return {
      transition: null,
      diagnostics: [`Commit ${input.commit} attests more than one transition: ${attested.join(", ")}`],
    };
  }
  const wanted = attested[0] as string;
  const candidate = input.transitions.find((transition) => transition.id === wanted);
  if (candidate === undefined) {
    return {
      transition: null,
      diagnostics: [`Attested transition ${wanted} for commit ${input.commit} has no transition record`],
    };
  }
  const parentsMatch = candidate.parents.length === input.parents.length
    && candidate.parents.every((parent, index) => parent === input.parents[index]);
  if (!parentsMatch || candidate.result !== input.result) {
    return {
      transition: null,
      diagnostics: [`Attested transition ${wanted} for commit ${input.commit} does not match the resolved trees`],
    };
  }
  return { transition: candidate, diagnostics: [] };
}
