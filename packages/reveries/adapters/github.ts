import { commitId, objectId } from "../src/protocol.ts";
import type { ReceiveCheckInput, ReceiveEvidence } from "../src/receive.ts";

export type GitHubEvidence = {
  readonly object: string;
  readonly baseTree?: string;
};

export type GitHubPullRequestProposal = {
  readonly number: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseTree: string;
  readonly notesTip: string;
  readonly evidence?: readonly GitHubEvidence[];
};

export type GitHubMergeGroupProposal = {
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseTree: string;
  readonly notesTip: string;
  readonly evidence?: readonly GitHubEvidence[];
};

function evidence(values: readonly GitHubEvidence[] | undefined): readonly ReceiveEvidence[] {
  return (values ?? []).map((item) => ({
    object: objectId(item.object),
    ...(item.baseTree === undefined ? {} : { baseTree: objectId(item.baseTree) }),
  }));
}

function notesUpdate(notesTip: string): ReceiveCheckInput["updates"][number] {
  const notes = objectId(notesTip);
  return { ref: "refs/notes/reveries", oldObject: notes, newObject: notes };
}

export function pullRequestReceiveProposal(input: GitHubPullRequestProposal): ReceiveCheckInput {
  const base = commitId(input.baseSha);
  const head = commitId(input.headSha);
  return {
    updates: [
      { ref: `refs/pull/${input.number}/head`, oldObject: base, newObject: head },
      notesUpdate(input.notesTip),
    ],
    baseTree: objectId(input.baseTree),
    evidence: evidence(input.evidence),
  };
}

export function mergeGroupReceiveProposal(input: GitHubMergeGroupProposal): ReceiveCheckInput {
  const base = commitId(input.baseSha);
  const head = commitId(input.headSha);
  return {
    updates: [
      { ref: input.baseRef, oldObject: base, newObject: head },
      notesUpdate(input.notesTip),
    ],
    baseTree: objectId(input.baseTree),
    evidence: evidence(input.evidence),
  };
}
