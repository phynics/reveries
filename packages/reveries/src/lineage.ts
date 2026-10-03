import type { CommitId, LineageKind, ObjectId, SubjectId } from "./protocol.ts";

/**
 * What produced a suggestion. There is exactly one basis in V1: Git's
 * similarity detection. Language adapters may propose symbol relationships,
 * but a proposal is still a proposal — it becomes evidence only when a person
 * records a lineage edge.
 */
export type SuggestionBasis = "git-similarity";

/**
 * A candidate relation that nobody has asserted.
 *
 * `confirmed` is always false here by construction: this module is the
 * suggestion surface, and it is deliberately not imported by validation or by
 * continuity. That is what keeps similarity from becoming silent authority —
 * the authoritative matcher in `operations.ts` reads raw diffs with rename
 * detection off, so a suggestion cannot quietly become a pairing.
 */
export type LineageSuggestion = {
  readonly basis: SuggestionBasis;
  readonly kind: LineageKind;
  readonly from: { readonly path: string; readonly subject: SubjectId };
  readonly to: { readonly path: string; readonly subject: SubjectId };
  /** Git's similarity score, 0-100. A number, never an authority. */
  readonly score: number;
  readonly confirmed: false;
};

export type SuggestionInput = {
  /** Subject that disappeared, with the path it had. */
  readonly from: { readonly path: string; readonly subject: SubjectId };
  /** Subject that appeared, with the path it now has. */
  readonly to: { readonly path: string; readonly subject: SubjectId };
  readonly score: number;
};

/**
 * Project one Git similarity candidate into a suggestion. A pure function so
 * the rule "similarity proposes, a person disposes" is testable without Git.
 *
 * A rename that Git scored but that produced identical content is not a
 * lineage question at all: the subject never changed, so universal evidence
 * already covers it and no edge is needed. Such a pair yields nothing.
 */
export function suggestLineage(input: SuggestionInput): readonly LineageSuggestion[] {
  if (input.from.subject === input.to.subject) return [];
  const score = Math.max(0, Math.min(100, Math.round(input.score)));
  if (score < 50) return [];
  // The shape is a proposal about content: same path means an edit in place,
  // which needs no lineage, and different content at the same path is a
  // replacement rather than a derivation.
  if (input.from.path === input.to.path) return [];
  return [{
    basis: "git-similarity",
    kind: "derive",
    from: input.from,
    to: input.to,
    score,
    confirmed: false,
  }];
}

/** The notice every suggestion surface must carry, in one place. */
export const SUGGESTION_NOTICE = "Similarity is a suggestion only: it is never evidence. "
  + "Record a lineage edge, and a per-decision continuation, supersession, or retirement, before a check can pass.";

/**
 * How a suggestion maps onto a recording command. The command is printed so an
 * operator can act on the proposal, but running it is still their decision and
 * still produces an ordinary durable record.
 */
export function suggestionCommand(
  suggestion: LineageSuggestion,
  commit: CommitId | string,
): string {
  const quote = (value: string): string => (/[\s"']/.test(value) ? JSON.stringify(value) : value);
  return [
    "reveries lineage record",
    `--kind ${suggestion.kind}`,
    `--commit ${String(commit)}`,
    `--from ${quote(suggestion.from.path)}`,
    `--to ${quote(suggestion.to.path)}`,
    "--driving-event", quote("Why the change moved or rewrote this subject."),
    "--decision", quote("Why this relation is the right one."),
    "--impact", quote("What follows from asserting it."),
  ].join(" ");
}

export type SuggestionSubject = { readonly path: string; readonly object: ObjectId };
