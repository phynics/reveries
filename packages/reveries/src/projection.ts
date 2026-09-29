import type {
  CommitId,
  CorrectionRecord,
  NoteRecord,
  ObjectId,
  PublicationAttestation,
  RedactionRecord,
  ResolutionRecord,
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

export type FactGraphProjection = {
  active: NoteRecord[];
  historical: NoteRecord[];
  duplicates: string[];
  forks: string[][];
  cycles: string[][];
  conflicts?: string[];
  /** Soft-redacted fact IDs: hidden from normal display and search, retained in bytes. */
  redacted: string[];
  /** True when concurrent session summaries form a fork instead of a replacement. */
  summaryFork: boolean;
};

type FactNode = CorrectionRecord | ResolutionRecord | ReverieRecord;

function factNodeId(record: NoteRecord): string | null {
  if (record.type === "reverie" || record.type === "correction" || record.type === "resolution") {
    return record.id;
  }
  return null;
}

function factNodeEdges(record: FactNode): readonly string[] {
  if (record.type === "resolution") return record.resolves;
  return record.supersedes;
}

function factNodeKey(record: FactNode): string {
  if (record.type === "reverie") {
    return `reverie\u0000${semanticKey(record)}`;
  }
  if (record.type === "correction") {
    return JSON.stringify({
      v: record.v,
      type: "correction",
      driving_event: record.driving_event,
      decision: record.decision,
      impact: record.impact,
      recurrence_control: record.recurrence_control,
      alternatives: record.alternatives,
      sources: record.sources,
      supersedes: record.supersedes,
    });
  }
  return JSON.stringify({
    v: record.v,
    type: "resolution",
    driving_event: record.driving_event,
    decision: record.decision,
    impact: record.impact,
    recurrence_control: record.recurrence_control,
    alternatives: record.alternatives,
    sources: record.sources,
    resolves: record.resolves,
  });
}

function redactionKey(record: RedactionRecord): string {
  return JSON.stringify({ v: record.v, target: record.target, reason: record.reason });
}

/**
 * Deterministic projection over the monotonic fact graph. Union stays a
 * pure set-union (see `unionFacts`); this computes the visible state:
 * unnamed heads are active, named heads are historical, multi-terminal
 * descendants are forks, and back-edges are cycles. A resolution that names
 * every terminal of a fork becomes its single terminal, so the fork
 * converges structurally; partial coverage keeps the fork visible. No
 * timestamp ever decides a winner. Pure: pass already-loaded records.
 */
export function projectFactGraph(records: readonly NoteRecord[]): FactGraphProjection {
  const nodes = new Map<string, FactNode>();
  const duplicateIds = new Set<string>();
  const conflictIds = new Set<string>();
  const seenKeys = new Map<string, string>();
  for (const record of records) {
    if (record.type !== "reverie" && record.type !== "correction" && record.type !== "resolution") {
      continue;
    }
    const id = factNodeId(record);
    if (id === null) continue;
    const key = factNodeKey(record);
    const existing = nodes.get(id);
    if (existing === undefined) {
      nodes.set(id, record);
      seenKeys.set(id, key);
      continue;
    }
    if (seenKeys.get(id) === key) duplicateIds.add(id);
    else conflictIds.add(id);
  }
  const redactionNodes = new Map<string, RedactionRecord>();
  for (const record of records) {
    if (record.type !== "redaction") continue;
    const existing = redactionNodes.get(record.id);
    if (existing === undefined) {
      redactionNodes.set(record.id, record);
      seenKeys.set(record.id, redactionKey(record));
      continue;
    }
    if (redactionKey(existing) === redactionKey(record)) duplicateIds.add(record.id);
    else conflictIds.add(record.id);
  }

  const children = new Map<string, string[]>();
  const superseded = new Set<string>();
  for (const record of nodes.values()) {
    const id = factNodeId(record);
    if (id === null) continue;
    for (const predecessor of factNodeEdges(record)) {
      superseded.add(predecessor);
      const list = children.get(predecessor) ?? [];
      list.push(id);
      children.set(predecessor, list);
    }
  }

  const byIdSort = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const active = [...nodes.values()]
    .filter((record) => {
      const id = factNodeId(record);
      return id !== null && !superseded.has(id);
    })
    .sort((left, right) => {
      const leftId = factNodeId(left) ?? "";
      const rightId = factNodeId(right) ?? "";
      return byIdSort(leftId, rightId);
    });
  const historical = [...nodes.values()]
    .filter((record) => {
      const id = factNodeId(record);
      return id !== null && superseded.has(id);
    })
    .sort((left, right) => {
      const leftId = factNodeId(left) ?? "";
      const rightId = factNodeId(right) ?? "";
      return byIdSort(leftId, rightId);
    });
  const forks: string[][] = [];
  for (const predecessor of children.keys()) {
    const terminals = new Set<string>();
    const visitedDescendants = new Set<string>();
    const collectTerminals = (id: string): void => {
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
    if (terminals.size > 1) forks.push([predecessor, ...[...terminals].sort(byIdSort)]);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const activePath = new Map<string, number>();
  const walk = (id: string, path: string[]): void => {
    const position = activePath.get(id);
    if (position !== undefined) {
      cycles.push(path.slice(position).concat(id));
      return;
    }
    if (visited.has(id)) return;
    const record = nodes.get(id);
    if (record === undefined) {
      visited.add(id);
      return;
    }
    activePath.set(id, path.length);
    for (const predecessor of factNodeEdges(record)) walk(predecessor, [...path, id]);
    activePath.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) walk(id, []);

  const redacted = [...new Set(
    [...redactionNodes.values()].map((record) => record.target as string),
  )].sort(byIdSort);
  const summaryFork = records.filter((record) => record.type === "session-summary").length > 1;

  return {
    active,
    historical,
    duplicates: [...duplicateIds].sort(byIdSort),
    forks,
    cycles,
    ...(conflictIds.size === 0 ? {} : { conflicts: [...conflictIds].sort(byIdSort) }),
    redacted,
    summaryFork,
  };
}

function factForkInvolvesNewKind(fork: readonly string[]): boolean {
  return fork.some((id) => id.startsWith("cr:") || id.startsWith("rs:"));
}

/**
 * Entry-level diagnostics for the fact graph beyond what the reverie-only
 * projection already reports. Pure-reverie forks, cycles, and conflicts stay
 * with `projectionDiagnostics`; this surfaces correction/resolution forks and
 * cycles, conflicting duplicate fact IDs, and session-summary forks so the
 * snapshot validator can fail closed on them.
 */
export function factGraphDiagnostics(graph: FactGraphProjection): string[] {
  const diagnostics: string[] = [];
  if (graph.forks.some(factForkInvolvesNewKind)) {
    diagnostics.push("Unresolved supersession fork detected");
  }
  if (graph.cycles.some(factForkInvolvesNewKind)) {
    diagnostics.push("Supersession cycle detected");
  }
  const conflicts = (graph.conflicts ?? []).filter(
    (id) => id.startsWith("cr:") || id.startsWith("rs:") || id.startsWith("rd:"),
  );
  if (conflicts.length > 0) diagnostics.push("Conflicting duplicate fact IDs detected");
  if (graph.summaryFork) diagnostics.push("Concurrent session summary fork detected");
  return diagnostics;
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
