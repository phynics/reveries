import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { GitRepository, hashBlobContent, NOTES_REF } from "../src/git.ts";
import { canonicalRecord, createReverie } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

/** One canonical reverie line; the tests only care that the bytes are valid. */
function reverieLine(decision: string): string {
  return canonicalRecord(createReverie(
    {
      v: 1,
      driving_event: "A publishing remote had no declared role.",
      decision,
      impact: "Only the primary may promote fetched evidence into canonical state.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    { author_email: "reveries@example.com", session: null, created_at: "2026-09-29T12:00:00Z" },
    (bytes) => hashBlobContent(bytes, "sha1"),
  ));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(prefix = "reveries-quarantine-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * The import-quarantine guarantee rests on one mechanism: `withNotesWrite`
 * validates a candidate and then unconditionally compare-and-swaps it into
 * `refs/notes/reveries`. These tests pin that promotion and quarantine run the
 * *same* validation and differ only in whether the canonical ref moves, so an
 * import can be inspected without ever becoming canonical.
 */

test("a quarantined candidate is validated and left out of the notes ref", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });

  // The remote side is a second repository that has annotated the same blob.
  const peer = await createRepository("reveries-quarantine-peer-");
  const peerRepository = await GitRepository.open(peer);
  await peerRepository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine("The peer published this decision."));
  });
  const peerTip = await peerRepository.notesTip();

  await git(directory, "fetch", peer, `+${NOTES_REF}:refs/notes/remotes/peer/reveries`);
  assert.equal(await repository.notesTip(), null);

  let validated = "";
  const quarantineRef = await repository.quarantineFetchedNotes(
    "peer",
    async (ref) => { validated = ref; },
  );

  // Validation ran against the real candidate, so a quarantined import is
  // inspected with the same checks a promoted one would have faced.
  assert.match(validated, /^refs\/notes\/reveries-txn\//);
  assert.match(quarantineRef, /^refs\/reveries\/quarantine\/peer\//);
  // The canonical ref is untouched: the import is inspectable, not canonical.
  assert.equal(await repository.notesTip(), null);
  assert.equal(await repository.notesTip(quarantineRef), peerTip);
});

test("promotion still moves the canonical notes ref", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });

  const peer = await createRepository("reveries-quarantine-peer-");
  const peerRepository = await GitRepository.open(peer);
  await peerRepository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine("The peer published this decision."));
  });
  const peerTip = await peerRepository.notesTip();

  await git(directory, "fetch", peer, `+${NOTES_REF}:refs/notes/remotes/peer/reveries`);

  const promoted = await repository.mergeFetchedNotes("peer");
  assert.equal(promoted, peerTip);
  assert.equal(await repository.notesTip(), peerTip);
});

test("a quarantined candidate is validated and still quarantined when it is invalid", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });

  const peer = await createRepository("reveries-quarantine-peer-");
  const peerRepository = await GitRepository.open(peer);
  await peerRepository.withNotesWrite(async (notes) => {
    await notes.append(blob, "this is not a canonical record\n");
  });

  await git(directory, "fetch", peer, `+${NOTES_REF}:refs/notes/remotes/peer/reveries`);

  // A validation failure keeps the original RVR-001 behaviour: the candidate is
  // still preserved at the quarantine ref so neither source history is lost.
  let quarantinedByFailure: string | null = null;
  await assert.rejects(
    () => repository.quarantineFetchedNotes(
      "peer",
      async () => { throw new Error("candidate is invalid"); },
      async (_ref, candidate) => { quarantinedByFailure = await repository.quarantineNotes("peer", candidate); },
    ),
    /candidate is invalid/,
  );
  assert.match(String(quarantinedByFailure), /^refs\/reveries\/quarantine\/peer\//);
  assert.equal(await repository.notesTip(), null);
  // The invalid candidate survives at the quarantine ref rather than being lost.
  assert.notEqual(await repository.notesTip(String(quarantinedByFailure)), null);
});

test("promote false leaves the canonical ref alone even for a valid candidate", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine("The local repository decided this."));
  });
  const before = await repository.notesTip();

  let seen: string | null = null;
  await repository.withNotesWrite(
    async (notes) => {
      await notes.append(blob, reverieLine("The candidate added this decision."));
    },
    async () => undefined,
    undefined,
    {
      promote: false,
      onCandidate: async (candidate) => { seen = candidate; },
    },
  );

  // The candidate was built and the hook observed it, which is what lets a
  // caller park it somewhere without the canonical ref ever moving.
  assert.notEqual(seen, null);
  assert.notEqual(seen, before);
  assert.equal(await repository.notesTip(), before);
});

test("promote defaults to true so existing callers are unchanged", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine("The local repository decided this."));
  });
  const before = await repository.notesTip();
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine("The second local decision."));
  });
  assert.notEqual(await repository.notesTip(), before);
});
