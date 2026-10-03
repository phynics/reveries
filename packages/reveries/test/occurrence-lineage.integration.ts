import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { NOTES_REF } from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import { checkReceive } from "../src/receive.ts";
import {
  canonicalRecord,
  commitId,
  createLineage,
  createOccurrence,
  objectId,
  parseNote,
  unionFacts,
  validateNote,
  type ReverieId,
  type ReverieInput,
  type ReverieMetadata,
  type ReveriesInit,
  type SessionSummary,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

/**
 * One blob that occurs at three paths, which is the situation universal
 * evidence cannot describe on its own: `src/` is hand written, `vendor/` is
 * generated, and `fixtures/` exists to be byte-compared.
 */
async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-occurrence-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  const shared = "shared payload\n";
  for (const path of ["src/left-pad.js", "vendor/left-pad.js", "fixtures/left-pad.js"]) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), shared, "utf8");
  }
  await mkdir(join(directory, "mod/inner"), { recursive: true });
  await writeFile(join(directory, "mod/a.txt"), "alpha\n", "utf8");
  await writeFile(join(directory, "mod/inner/b.txt"), "beta\n", "utf8");
  await writeFile(join(directory, "top.txt"), "top\n", "utf8");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  while (temporaryRepositories.length > 0) {
    const directory = temporaryRepositories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:occurrence-lineage",
  created_at: "2026-10-03T00:00:00Z",
};

const universal: ReverieInput = {
  v: 1,
  driving_event: "The same file is vendored, hand written, and used as a fixture.",
  decision: "Keep the universal decision about the exact bytes because it holds for all of them.",
  impact: "Every occurrence of this content resolves the same evidence.",
  recurrence_control: "The repeated-blob fixture fails when universal evidence stops covering every path.",
  alternatives: [],
  sources: [],
  supersedes: [],
};

function summary(retirements: SessionSummary["entries"][number]["retirements"] = []): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:occurrence-lineage",
    created_at: "2026-10-03T00:05:00Z",
    entries: [{
      driving_event: "The commit changed tracked content.",
      decision: "Summarize the commit because every descendant requires a causal account.",
      impact: "Reviewers read the change beside its causal account.",
      recurrence_control: "The commit check requires one summary per descendant commit.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements,
    }],
  };
}

function initialization(): ReveriesInit {
  return {
    v: 1,
    type: "reveries-init",
    protocol: 1,
    notes_ref: "refs/notes/reveries",
    publishing_remotes: [],
    hosts: ["codex"],
    author_email: "reveries@example.com",
    created_at: "2026-10-03T00:00:00Z",
  };
}

async function adopt(directory: string, reveries: Reveries): Promise<string> {
  const adoption = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: adoption, summary: summary() });
  await reveries.attachInitialization({ commit: adoption, record: initialization() });
  return adoption;
}

/**
 * The coordinate key the authority check matches on: a revision, a path, and the
 * subject found there. A subject OID alone would let an edge claim a path that
 * never held it.
 */
function coordinate(revision: string, path: string, subject: string): string {
  return `${revision}\u0000${path}\u0000${subject}`;
}

function captureIo(cwd: string): { readonly io: CliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      cwd,
      stdin: async () => "",
      stdout: (text) => { out += text; },
      stderr: (text) => { err += text; },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

// --- Acceptance criterion 1: two occurrences, different evidence -----------------

test("two occurrences of one blob carry different evidence and share the universal record", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const shared = await reveries.recordNew({ path: "src/left-pad.js", revision: "HEAD", semantic: universal, metadata });
  assert.deepEqual([...shared.paths].sort(), [
    "fixtures/left-pad.js",
    "src/left-pad.js",
    "vendor/left-pad.js",
  ]);

  const vendored = await reveries.recordOccurrence({
    path: "vendor/left-pad.js",
    revision: "HEAD",
    semantic: {
      v: 1,
      occurrence: undefined as never,
      driving_event: "The vendored copy is regenerated by the upstream import.",
      decision: "Treat the vendored occurrence as generated because edits are overwritten.",
      impact: "Local edits there are lost on the next import and carry no review.",
      recurrence_control: "The occurrence fixture fails when the vendored rationale reaches the authored path.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  const authored = await reveries.recordOccurrence({
    path: "src/left-pad.js",
    revision: "HEAD",
    semantic: {
      v: 1,
      occurrence: undefined as never,
      driving_event: "The authored copy is maintained by this repository.",
      decision: "Maintain the authored occurrence here because tests import it directly.",
      impact: "Changes to it need review and a changelog entry.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  assert.equal(vendored.record.occurrence.subject, shared.object);
  assert.equal(authored.record.occurrence.subject, shared.object);
  assert.notEqual(vendored.record.id, authored.record.id);
  assert.equal(vendored.record.occurrence.path, "vendor/left-pad.js");
  assert.equal(authored.record.occurrence.path, "src/left-pad.js");

  // The universal record is untouched by either occurrence.
  for (const path of ["src/left-pad.js", "vendor/left-pad.js", "fixtures/left-pad.js"]) {
    const shown = await reveries.show({ target: path, revision: "HEAD" });
    assert.equal(shown.active[0]?.id, shared.record.id, path);
  }
});

// --- Display contract: a shared blob is not a universal occurrence --------------

test("show at one path never presents another occurrence's rationale as applicable", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await reveries.recordOccurrence({
    path: "vendor/left-pad.js",
    revision: "HEAD",
    semantic: {
      v: 1,
      occurrence: undefined as never,
      driving_event: "The vendored copy is regenerated.",
      decision: "Treat the vendored occurrence as generated.",
      impact: "Edits are overwritten by the next import.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  const atVendor = await reveries.show({ target: "vendor/left-pad.js", revision: "HEAD" });
  assert.equal(atVendor.occurrences.length, 1);
  assert.equal(atVendor.occurrences[0]?.applicable, true);
  assert.equal(atVendor.occurrences[0]?.reason, null);

  const atSource = await reveries.show({ target: "src/left-pad.js", revision: "HEAD" });
  assert.equal(atSource.occurrences.length, 1, "the record is still visible on the shared blob");
  assert.equal(atSource.occurrences[0]?.applicable, false);
  assert.match(atSource.occurrences[0]?.reason ?? "", /anchored at vendor\/left-pad\.js/);

  const atFixture = await reveries.show({ target: "fixtures/left-pad.js", revision: "HEAD" });
  assert.equal(atFixture.occurrences[0]?.applicable, false);

  // Raw object inspection still lists the record with its coordinate.
  const byOid = await reveries.show({ target: String(atSource.object), revision: "HEAD" });
  assert.ok(byOid.records.some((record) => record.type === "occurrence"));

  const captured = captureIo(directory);
  assert.equal(await runCli(["show", "src/left-pad.js"], captured.io), 0);
  const text = captured.stdout();
  assert.match(text, /Anchored elsewhere \(not evidence for this occurrence\)/);
  assert.match(text, /vendor\/left-pad\.js/);
  assert.doesNotMatch(text, /Active decisions \(every occurrence[^)]*\):[\s\S]*Treat the vendored occurrence/);
});

test("search reports an occurrence with its coordinate and whether it still applies", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await reveries.recordOccurrence({
    path: "vendor/left-pad.js",
    revision: "HEAD",
    semantic: {
      v: 1,
      occurrence: undefined as never,
      driving_event: "The vendored copy is regenerated.",
      decision: "Treat the vendored occurrence as generated because upstream owns it.",
      impact: "Edits are overwritten by the next import.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  const hits = await reveries.search({ query: "generated" });
  const occurrenceHits = hits.filter((hit) => hit.record.type === "occurrence");
  assert.equal(occurrenceHits.length, 1);
  assert.equal(occurrenceHits[0]?.occurrence?.path, "vendor/left-pad.js");
  assert.equal(occurrenceHits[0]?.applicable, true);
  assert.deepEqual(occurrenceHits[0]?.paths, [
    "fixtures/left-pad.js",
    "src/left-pad.js",
    "vendor/left-pad.js",
  ]);

  // Once the path no longer holds the content, the record is historical
  // evidence rather than a claim about the current occurrence.
  await git(directory, "mv", "vendor/left-pad.js", "vendor/renamed-pad.js");
  await git(directory, "commit", "-m", "rename the vendored copy");
  const after = await reveries.search({ query: "generated" });
  const afterHits = after.filter((hit) => hit.record.type === "occurrence");
  assert.equal(afterHits.length, 1);
  assert.equal(afterHits[0]?.applicable, false);
  assert.equal(afterHits[0]?.occurrence?.path, "vendor/left-pad.js");
});

test("an unchanged descendant commit leaves occurrence evidence anchored historically", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordOccurrence({
    path: "vendor/left-pad.js",
    revision: "HEAD",
    semantic: {
      v: 1,
      occurrence: undefined as never,
      driving_event: "The vendored copy is regenerated.",
      decision: "Treat the vendored occurrence as generated.",
      impact: "Edits are overwritten.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  // A later commit touches something else entirely.
  await writeFile(join(directory, "top.txt"), "top changed\n", "utf8");
  await git(directory, "add", "top.txt");
  await git(directory, "commit", "-m", "unrelated change");
  const head = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: head, summary: summary() });
  assert.equal((await reveries.checkCommit(head)).ok, true);

  const shown = await reveries.show({ target: "vendor/left-pad.js", revision: "HEAD" });
  assert.equal(shown.occurrences[0]?.record.id, recorded.record.id);
  assert.equal(shown.occurrences[0]?.applicable, false);
  assert.match(shown.occurrences[0]?.reason ?? "", /anchored at vendor\/left-pad\.js/);
  // The anchor still names the revision the evidence was written about.
  assert.equal(shown.occurrences[0]?.occurrence.commit, recorded.record.occurrence.commit);

  const hits = await reveries.search({ query: "generated" });
  const occurrenceHit = hits.find((hit) => hit.record.type === "occurrence");
  assert.equal(occurrenceHit?.applicable, false);
  assert.equal(occurrenceHit?.occurrence?.commit, recorded.record.occurrence.commit);

  // And it is still not evidence for the other paths holding the same bytes.
  const atSource = await reveries.show({ target: "src/left-pad.js", revision: "HEAD" });
  assert.equal(atSource.occurrences[0]?.applicable, false);
});

// --- Acceptance criterion 4: moves follow explicit lineage ---------------------

test("a renamed-and-edited subtree needs a lineage edge and per-decision evidence", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });
  const predecessor = String(recorded.object);

  await git(directory, "mv", "mod", "moved");
  await writeFile(join(directory, "moved/a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "rename and edit the module");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  await reveries.summarize({ commit, summary: summary() });

  // Without any lineage the obligation stands, exactly as before.
  const withoutEdge = await reveries.checkCommit(commit);
  assert.equal(withoutEdge.ok, false);
  assert.match(withoutEdge.diagnostics.join("\n"), new RegExp(`${recorded.record.id} from ${predecessor}: missing-disposition`));

  // An edge alone still discharges nothing.
  const edge = await reveries.recordLineage({
    kind: "preserve",
    parent,
    commit: String(commit),
    from: ["mod"],
    to: ["moved"],
    semantic: {
      driving_event: "The module was renamed and its content edited in one change.",
      decision: "Pair the old subtree with the new one because the intent is unchanged.",
      impact: "Path history and continuity follow the rename instead of losing it.",
      recurrence_control: "The move fixture fails closed while any decision lacks a disposition.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  assert.equal(edge.record.kind, "preserve");
  const stillBlocked = await reveries.checkCommit(commit);
  assert.equal(stillBlocked.ok, false, "a lineage pair must not discharge a decision by itself");
  assert.match(stillBlocked.diagnostics.join("\n"), /missing-disposition/);

  const successor = (await reveries.repository.resolveSubject({ path: "moved", revision: String(commit) })).object;
  await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: successor, id: recorded.record.id });
  const passed = await reveries.checkCommit(commit);
  assert.equal(passed.ok, true, JSON.stringify(passed.diagnostics));
  assert.equal(passed.diagnostics.length, 0);

  // Path history follows the rename through the edge, reaching the coordinate
  // the edge says the subject came from.
  const history = await reveries.history("moved");
  const followed = history.filter((entry) => entry.viaLineage === edge.record.id);
  assert.equal(followed.length, 1);
  assert.equal(followed[0]?.commit, String(parent));
  assert.equal(followed[0]?.path, "mod");
  // The same walk reports both coordinates, in a deterministic order.
  assert.deepEqual(
    history.map((entry) => `${entry.path}:${entry.viaLineage === edge.record.id ? "via-edge" : "direct"}`),
    ["moved:direct", "mod:via-edge"],
  );
});

test("history reaches the earlier coordinate the edge names", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });
  const oldTree = String(recorded.object);

  await git(directory, "mv", "mod", "moved");
  await writeFile(join(directory, "moved/a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "rename and edit the module");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  const edge = await reveries.recordLineage({
    kind: "preserve",
    parent,
    commit: String(commit),
    from: ["mod"],
    to: ["moved"],
    semantic: {
      driving_event: "The module moved and changed in one commit.",
      decision: "Pair the two subtrees because the layout decision still holds.",
      impact: "A history walk of the new path reaches the old one.",
      recurrence_control: "The history fixture asserts the edge is followed.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  await reveries.summarize({ commit, summary: summary() });

  const history = await reveries.history("moved");
  const coordinates = history
    .map((entry) => `${entry.path}:${String(entry.subject ?? entry.blob)}`)
    .filter((value) => value.includes(oldTree));
  assert.deepEqual(coordinates, [`mod:${oldTree}`]);
  assert.ok(history.some((entry) => entry.viaLineage === edge.record.id));
});

// --- Split and join ------------------------------------------------------------

test("a split needs evidence at each successor and names the unfinished one", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });

  await git(directory, "rm", "-r", "mod");
  await mkdir(join(directory, "one"), { recursive: true });
  await mkdir(join(directory, "two"), { recursive: true });
  await writeFile(join(directory, "one/a.txt"), "alpha\n", "utf8");
  await writeFile(join(directory, "two/a.txt"), "alpha, the other half\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "split the module in two");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  await reveries.summarize({ commit, summary: summary() });

  await reveries.recordLineage({
    kind: "split",
    parent,
    commit: String(commit),
    from: ["mod"],
    to: ["one", "two"],
    semantic: {
      driving_event: "One module became two directories with separate ownership.",
      decision: "Record the split because the predecessor has two successors.",
      impact: "Both successors inherit the obligation, not just one of them.",
      recurrence_control: "The split fixture fails when an endpoint has no disposition.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  const one = (await reveries.repository.resolveSubject({ path: "one", revision: String(commit) })).object;
  const two = (await reveries.repository.resolveSubject({ path: "two", revision: String(commit) })).object;
  // One endpoint answered, the other not: the check names the bare one.
  await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: one, id: recorded.record.id });
  const partial = await reveries.checkCommit(commit);
  assert.equal(partial.ok, false);
  assert.match(partial.diagnostics.join("\n"), new RegExp(`${String(two)}`));
  assert.match(partial.diagnostics.join("\n"), /missing-disposition/);

  await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: two, id: recorded.record.id });
  assert.equal((await reveries.checkCommit(commit)).ok, true);
});

test("a join pairs two annotated predecessors through one successor", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const first = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });

  await mkdir(join(directory, "extra"), { recursive: true });
  await writeFile(join(directory, "extra/c.txt"), "gamma\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "add the second directory");
  const withExtra = commitId(await git(directory, "rev-parse", "HEAD"));
  const extra = await reveries.recordNew({ path: "extra", revision: String(withExtra), semantic: universal, metadata });
  await reveries.summarize({ commit: withExtra, summary: summary() });
  await git(directory, "rm", "-r", "mod", "extra");
  await mkdir(join(directory, "joined"), { recursive: true });
  await writeFile(join(directory, "joined/a.txt"), "alpha\n", "utf8");
  await writeFile(join(directory, "joined/c.txt"), "gamma\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "join into one directory");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  await reveries.summarize({ commit, summary: summary() });

  const merged = await reveries.recordLineage({
    kind: "merge",
    parent,
    commit: String(commit),
    from: ["mod", "extra"],
    to: ["joined"],
    semantic: {
      driving_event: "Two directories were combined into one.",
      decision: "Record the merge because both predecessors have one successor.",
      impact: "Each predecessor keeps its own obligation until its decision is dispositioned.",
      recurrence_control: "The merge fixture fails when a predecessor has no disposition.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  assert.equal(merged.record.from.length, 2);

  const joined = (await reveries.repository.resolveSubject({ path: "joined", revision: String(commit) })).object;
  const blocked = await reveries.checkCommit(commit);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.diagnostics.filter((line) => line.includes("missing-disposition")).length, 2);

  await reveries.recordContinueToBlob({ fromBlob: first.object, toBlob: joined, id: first.record.id });
  await reveries.recordContinueToBlob({ fromBlob: extra.object, toBlob: joined, id: extra.record.id });
  assert.equal((await reveries.checkCommit(commit)).ok, true);
});

test("a derive edge expresses a true N-to-M relation", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });

  await git(directory, "rm", "-r", "mod");
  for (const path of ["x", "y", "z"]) {
    await mkdir(join(directory, path), { recursive: true });
    await writeFile(join(directory, path, "a.txt"), "alpha\n", "utf8");
  }
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "reorganize one module into three");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  await reveries.summarize({ commit, summary: summary() });

  const edge = await reveries.recordLineage({
    kind: "derive",
    parent,
    commit: String(commit),
    from: ["mod"],
    to: ["x", "y", "z"],
    semantic: {
      driving_event: "One module became three without a single obvious split point.",
      decision: "Record a derive relation because the shape is neither a clean split nor a join.",
      impact: "All three successors owe the predecessor's decision independently.",
      recurrence_control: "The N-to-M fixture fails when any successor lacks evidence.",
      alternatives: ["Claim it as a split even though no single successor continues the whole design"],
      sources: [],
    },
    metadata,
  });
  assert.equal(edge.record.to.length, 3);
  assert.equal((await reveries.checkCommit(commit)).ok, false);

  for (const path of ["x", "y", "z"]) {
    const successor = (await reveries.repository.resolveSubject({ path, revision: String(commit) })).object;
    await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: successor, id: recorded.record.id });
  }
  assert.equal((await reveries.checkCommit(commit)).ok, true);
});

test("a retire edge marks termination but discharges no decision", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });

  await git(directory, "rm", "-r", "mod");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "delete the module");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  await reveries.summarize({ commit, summary: summary() });

  const edge = await reveries.recordLineage({
    kind: "retire",
    parent,
    commit: String(commit),
    from: ["mod"],
    to: [],
    semantic: {
      driving_event: "The module was deleted outright.",
      decision: "Record the termination of that occurrence because nothing replaced it.",
      impact: "The decision still needs its own causal retirement.",
      recurrence_control: "The retire fixture asserts the edge alone does not pass a check.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  assert.equal(edge.record.to.length, 0);
  const blocked = await reveries.checkCommit(commit);
  assert.equal(blocked.ok, false);
  assert.match(blocked.diagnostics.join("\n"), /missing-disposition/);

  const retiring = summary([{
    reverie: recorded.record.id,
    from_blob: recorded.object,
    reason: "The module was deleted and nothing replaced it.",
  }]);
  await reveries.summarize({ commit, summary: retiring, replace: true });
  assert.equal((await reveries.checkCommit(commit)).ok, true);
});

// --- Authority binding ---------------------------------------------------------

test("an edge bound to another parent is history, not authority", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });
  const root = await git(directory, "rev-parse", "HEAD");

  await writeFile(join(directory, "top.txt"), "top changed\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "unrelated commit");
  const earlier = commitId(await git(directory, "rev-parse", "HEAD"));
  await reveries.summarize({ commit: earlier, summary: summary() });

  await git(directory, "mv", "mod", "moved");
  await writeFile(join(directory, "moved/a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "rename and edit");
  const rename = commitId(await git(directory, "rev-parse", "HEAD"));
  await reveries.summarize({ commit: rename, summary: summary() });

  const edge = await reveries.recordLineage({
    kind: "preserve",
    parent: earlier,
    commit: String(rename),
    from: ["mod"],
    to: ["moved"],
    semantic: {
      driving_event: "The module was renamed and edited in one commit.",
      decision: "Pair the two subtrees because the intent is unchanged.",
      impact: "Only the commit it names may treat it as the pairing.",
      recurrence_control: "The binding fixture asserts a mismatched commit changes nothing.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  const disturbed = new Set([coordinate(String(earlier), "mod", String(recorded.object))]);
  // For its own change the edge is the pairing authority.
  const forRename = await reveries.classifyLineage({ commit: rename, parent: earlier, disturbed });
  assert.equal(forRename.used[0]?.authority, "authoritative");
  assert.equal(forRename.pairings.length, 1);

  // For any other change the same edge is history and carries no authority.
  const forEarlier = await reveries.classifyLineage({
    commit: earlier,
    parent: commitId(root),
    disturbed: new Set([coordinate(String(commitId(root)), "mod", String(recorded.object))]),
  });
  assert.deepEqual(forEarlier.used, []);
  assert.deepEqual(forEarlier.historyOnly, [edge.record.id]);
  assert.deepEqual(forEarlier.pairings, []);

  // The rename check still needs the per-decision continuation, and the
  // earlier commit needed no pairing at all.
  assert.equal((await reveries.checkCommit(earlier)).ok, true);
  const blocked = await reveries.checkCommit(rename);
  assert.equal(blocked.ok, false);
  assert.match(blocked.diagnostics.join("\n"), /missing-disposition/);
});

test("an edge naming a subject the commit did not change is contradictory", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const annotatedMod = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });
  await reveries.recordNew({ path: "top.txt", revision: "HEAD", semantic: universal, metadata });

  await git(directory, "mv", "mod", "moved");
  await writeFile(join(directory, "moved/a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "rename and edit");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  await reveries.summarize({ commit, summary: summary() });

  const topBlob = await git(directory, "rev-parse", `${commit}:top.txt`);
  const movedTree = await git(directory, "rev-parse", `${commit}:moved`);
  // The edge claims a predecessor that this commit never disturbed. The
  // record gate refuses such an edge, so this fixture forges it by hand to
  // prove the check itself still fails closed when the gate is bypassed.
  const edge = await forgeLineage(
    directory,
    commit,
    {
      kind: "derive",
      parent,
      fromPath: "top.txt",
      fromSubject: topBlob,
      toPath: "moved",
      toSubject: movedTree,
    },
  );
  assert.ok(topBlob.length === 40);

  const classified = await reveries.classifyLineage({
    commit,
    parent: commitId(parent),
    disturbed: new Set([coordinate(parent, "mod", String(annotatedMod.object))]),
  });
  assert.equal(classified.used[0]?.authority, "contradictory");
  assert.match(classified.used[0]?.detail ?? "", /top\.txt at [0-9a-f]{12} is not a subject this commit disturbs/);
  assert.deepEqual(classified.pairings, []);

  const blocked = await reveries.checkCommit(commit);
  assert.equal(blocked.ok, false);
  assert.match(blocked.diagnostics.join("\n"), new RegExp(`contradictory-lineage ${edge.record.id}`));
});

test("two edges pairing one predecessor fail closed", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });

  await git(directory, "mv", "mod", "moved");
  await writeFile(join(directory, "moved/a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "rename and edit");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  await reveries.summarize({ commit, summary: summary() });

  const first = await reveries.recordLineage({
    kind: "preserve",
    parent,
    commit: String(commit),
    from: ["mod"],
    to: ["moved"],
    semantic: {
      driving_event: "The first claim about the rename.",
      decision: "Pair the subtree with its new home.",
      impact: "A second, different claim is what makes this ambiguous.",
      recurrence_control: "The ambiguity fixture asserts two claims fail closed.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  await mkdir(join(directory, "other"), { recursive: true });
  await writeFile(join(directory, "other/a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "add an unrelated directory");
  const second = commitId(await git(directory, "rev-parse", "HEAD"));
  await reveries.summarize({ commit: second, summary: summary() });

  // A second edge for the same predecessor and a different successor set.
  const conflicting = await reveries.recordLineage({
    kind: "preserve",
    parent,
    commit: String(commit),
    from: ["mod"],
    to: ["top.txt"],
    semantic: {
      driving_event: "A second, different claim about the same predecessor.",
      decision: "Assert a second pairing so the check must refuse both.",
      impact: "Ambiguity is reported instead of resolved by reading order.",
      recurrence_control: "The ambiguity fixture asserts the refusal.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  assert.notEqual(conflicting.record.id, first.record.id);

  const blocked = await reveries.checkCommit(commit);
  assert.equal(blocked.ok, false);
  assert.match(blocked.diagnostics.join("\n"), /ambiguous-pairing/);
});

// --- Acceptance criterion 3: similarity is never authority ---------------------

test("a high-similarity rename with a copied record and no edge fails every gate", async () => {
  const { source, bare } = await setupBare();
  const reveries = await Reveries.open(source);
  await adopt(source, reveries);
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  await writeFile(join(source, "big.txt"), `${lines}\n`, "utf8");
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "add a large file");
  const withFile = await git(source, "rev-parse", "HEAD");
  await reveries.summarize({ commit: commitId(withFile), summary: summary() });

  const recorded = await reveries.recordNew({ path: "big.txt", revision: String(withFile), semantic: universal, metadata });
  await git(source, "push", "origin", "main", "refs/notes/reveries");
  const oldNotes = await git(source, "rev-parse", "refs/notes/reveries");

  // One line changes, so Git is confident this is a rename.
  await git(source, "mv", "big.txt", "renamed.txt");
  const changed = `${lines.replace("line 7", "line seven")}\n`;
  await writeFile(join(source, "renamed.txt"), changed, "utf8");
  await git(source, "add", "-A");
  const successorBlob = await git(source, "rev-parse", ":renamed.txt");
  // The record is copied onto the successor: exactly what similarity pairing
  // used to accept as a continuation.
  await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: objectId(successorBlob), id: recorded.record.id });
  await git(source, "commit", "-m", "rename and tweak");
  const commit = commitId(await git(source, "rev-parse", "HEAD"));
  await reveries.summarize({ commit, summary: summary() });

  const blocked = await reveries.checkCommit(commit);
  assert.equal(blocked.ok, false, JSON.stringify(blocked.diagnostics));
  assert.match(blocked.diagnostics.join("\n"), new RegExp(`${recorded.record.id} from ${String(recorded.object)}: missing-disposition`));

  // Similarity still proposes the relation, without asserting it.
  const suggestions = await reveries.suggestLineage({ revision: String(commit) });
  assert.equal(suggestions.suggestions.length, 1);
  assert.equal(suggestions.suggestions[0]?.confirmed, false);
  assert.equal(suggestions.suggestions[0]?.from.path, "big.txt");
  assert.equal(suggestions.suggestions[0]?.to.path, "renamed.txt");
  assert.ok((suggestions.suggestions[0]?.score ?? 0) >= 50);

  // The receive gate refuses the same push: similarity is not authority there either.
  const newTip = await git(source, "rev-parse", "HEAD");
  const newNotes = await git(source, "rev-parse", "refs/notes/reveries");
  await git(source, "push", "origin", "main:refs/heads/proposed", "refs/notes/reveries:refs/notes/proposed");
  const refused = await checkReceive(bare, {
    updates: [
      { ref: "refs/heads/main", oldObject: objectId(withFile), newObject: objectId(newTip) },
      { ref: NOTES_REF, oldObject: objectId(oldNotes), newObject: objectId(newNotes) },
    ],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.findings.some((finding) => finding.code === "missing-continuity-disposition"), true);

  // Recording the edge plus per-decision evidence is what makes it pass.
  const parent = await git(source, "rev-parse", "HEAD^");
  await reveries.recordLineage({
    kind: "derive",
    parent,
    commit: String(commit),
    from: ["big.txt"],
    to: ["renamed.txt"],
    semantic: {
      driving_event: "The file was renamed and one line changed.",
      decision: "Pair the two contents because the intent is unchanged.",
      impact: "History and continuity follow the rename.",
      recurrence_control: "The similarity fixture asserts the edge is required.",
      alternatives: ["Trust the similarity score as the pairing"],
      sources: [],
    },
    metadata,
  });
  assert.equal((await reveries.checkCommit(commit)).ok, true, "the copied record is the per-decision continuation");

  const acceptedNotes = await git(source, "rev-parse", "refs/notes/reveries");
  await git(source, "push", "origin", "main:refs/heads/proposed2", "refs/notes/reveries:refs/notes/proposed2");
  const accepted = await checkReceive(bare, {
    updates: [
      { ref: "refs/heads/main", oldObject: objectId(withFile), newObject: objectId(newTip) },
      { ref: NOTES_REF, oldObject: objectId(oldNotes), newObject: objectId(acceptedNotes) },
    ],
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
});

test("a staged high-similarity rename fails without an explicit successor", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  await writeFile(join(directory, "big.txt"), `${lines}\n`, "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "add a large file");
  const recorded = await reveries.recordNew({ path: "big.txt", revision: "HEAD", semantic: universal, metadata });

  await git(directory, "mv", "big.txt", "renamed.txt");
  await writeFile(join(directory, "renamed.txt"), `${lines.replace("line 9", "line nine")}\n`, "utf8");
  await git(directory, "add", "-A");

  // Used to pass silently because Git paired the rename by similarity.
  const blocked = await reveries.checkStaged();
  assert.equal(blocked.ok, false);
  assert.match(blocked.diagnostics.join("\n"), /missing-disposition/);
  assert.match(blocked.diagnostics.join("\n"), new RegExp(recorded.record.id));

  // The explicit local map still resolves it once the decision is carried over.
  const successor = (await reveries.repository.resolveSubject({ path: "renamed.txt", revision: "index" })).object;
  await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: successor, id: recorded.record.id });
  const mapped = await reveries.checkStaged(new Map([["big.txt", "renamed.txt"]]));
  assert.equal(mapped.ok, true, JSON.stringify(mapped.diagnostics));
  const captured = captureIo(directory);
  const usage = await runCli(["check", "--staged", "--successor", "big.txt=renamed.txt"], captured.io);
  assert.equal(usage, 0);
});

// --- A forged coordinate is never authority ------------------------------------

/**
 * A lineage record written by hand, bypassing the record gate: useful for
 * edges the gate itself would refuse (undisturbed predecessors, unresolvable
 * pairings), proving the check still fails closed when the gate is bypassed.
 */
async function forgeLineage(
  directory: string,
  commit: string,
  input: {
    readonly kind: "preserve" | "split" | "merge" | "derive" | "retire";
    readonly parent: string;
    readonly fromPath: string;
    readonly fromSubject: string;
    readonly toPath: string;
    readonly toSubject: string;
  },
): Promise<{ readonly record: { readonly id: string } }> {
  const record = createLineage(
    {
      v: 1,
      kind: input.kind,
      parent: commitId(input.parent),
      commit: commitId(commit),
      from: [{ path: input.fromPath, subject: objectId(input.fromSubject) }],
      to: [{ path: input.toPath, subject: objectId(input.toSubject) }],
      transition: null,
      driving_event: "A hand-written edge that bypasses the record gate.",
      decision: "Prove the check fails closed even when the gate is bypassed.",
      impact: "Authority must refuse this rather than trust the object ID.",
      recurrence_control: "The forged-edge fixture asserts the refusal.",
      alternatives: [],
      sources: [],
    },
    metadata,
    (bytes) => objectId(createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex")) as never,
  );
  const existing = await git(directory, "notes", `--ref=${NOTES_REF}`, "show", commit);
  const poisoned = `${existing.replace(/\n*$/, "")}\n${canonicalRecord(record)}`;
  const path = join(directory, "forged-lineage.jsonl");
  await writeFile(path, poisoned, "utf8");
  try {
    await git(directory, "notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", path, commit);
  } finally {
    await rm(path, { force: true });
  }
  return { record: { id: record.id } };
}

/**
 * A lineage record written by hand, bypassing the helper: the subjects it names
 * are real, but one path does not hold the subject it claims. Nothing about the
 * object IDs is wrong, so an authority check that matched on subjects alone
 * would pair this edge and pass the gate.
 */
async function forgeLineageWithWrongPath(
  directory: string,
  commit: string,
  parent: string,
  fromPath: string,
  fromSubject: string,
  toSubject: string,
): Promise<string> {
  const record = createLineage(
    {
      v: 1,
      kind: "preserve",
      parent: commitId(parent),
      commit: commitId(commit),
      from: [{ path: fromPath, subject: objectId(fromSubject) }],
      // `top.txt` is a file: it cannot hold the tree this edge claims.
      to: [{ path: "top.txt", subject: objectId(toSubject) }],
      transition: null,
      driving_event: "A hand-written edge that names a real subject at the wrong path.",
      decision: "Pair the moved subtree with a path that never held it.",
      impact: "Authority must refuse this rather than trust the object ID.",
      recurrence_control: "The forged-coordinate fixture asserts the refusal.",
      alternatives: [],
      sources: [],
    },
    metadata,
    (bytes) => objectId(createHash("sha1").update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest("hex")) as never,
  );
  const existing = await git(directory, "notes", `--ref=${NOTES_REF}`, "show", commit);
  const poisoned = `${existing.replace(/\n*$/, "")}\n${canonicalRecord(record)}`;
  const path = join(directory, "forged-note.jsonl");
  await writeFile(path, poisoned, "utf8");
  try {
    await git(directory, "notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", path, commit);
  } finally {
    await rm(path, { force: true });
  }
  return record.id;
}

test("a hand-written edge naming a real subject at the wrong path is refused everywhere", async () => {
  const { source, bare } = await setupBare();
  const reveries = await Reveries.open(source);
  await adopt(source, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });
  await git(source, "push", "origin", "main", "refs/notes/reveries");
  const publishedTip = await git(source, "rev-parse", "HEAD");
  const publishedNotes = await git(source, "rev-parse", "refs/notes/reveries");

  await git(source, "mv", "mod", "moved");
  await writeFile(join(source, "moved/a.txt"), "alpha changed\n", "utf8");
  await git(source, "add", "-A");
  await git(source, "commit", "-m", "rename and edit the module");
  const commit = await git(source, "rev-parse", "HEAD");
  const parent = await git(source, "rev-parse", "HEAD^");
  await reveries.summarize({ commit: commitId(commit), summary: summary() });
  // The outgoing gate needs the remote-tracking notes ref, exactly as it would
  // after a normal publish-and-fetch cycle.
  await git(source, "fetch", "origin", "+refs/notes/reveries*:refs/notes/remotes/origin/reveries*");

  const moved = await git(source, "rev-parse", `${commit}:moved`);
  const forged = await forgeLineageWithWrongPath(
    source,
    commit,
    parent,
    "mod",
    String(recorded.object),
    moved,
  );
  assert.match(forged, /^lg:[0-9a-f]{40}$/);

  // The helper refuses to write it at all.
  await assert.rejects(
    reveries.mutateNotes(async () => {}),
    /does not resolve|holds/,
  );

  // Even after it is in the notes, it is not authority.
  const blocked = await reveries.checkCommit(commitId(commit));
  assert.equal(blocked.ok, false, JSON.stringify(blocked.diagnostics));
  assert.match(blocked.diagnostics.join("\n"), new RegExp(`contradictory-lineage ${forged}`));

  const outgoing = await reveries.checkOutgoing("origin");
  assert.equal(outgoing.ok, false);
  assert.match(outgoing.diagnostics.join("\n"), /top\.txt|contradictory-lineage|non-lineage/);

  // And the receive gate refuses the proposed notes before it derives authority.
  const newTip = await git(source, "rev-parse", "HEAD");
  const newNotes = await git(source, "rev-parse", "refs/notes/reveries");
  await git(source, "push", "origin", "main:refs/heads/proposed", "refs/notes/reveries:refs/notes/proposed");
  const refused = await checkReceive(bare, {
    updates: [
      { ref: "refs/heads/main", oldObject: objectId(publishedTip), newObject: objectId(newTip) },
      { ref: NOTES_REF, oldObject: objectId(publishedNotes), newObject: objectId(newNotes) },
    ],
  });
  assert.equal(refused.ok, false);
  assert.match(refused.diagnostics.join("\n"), /top\.txt/);

  // Replacing it with a correctly bound edge is what makes the same push pass.
  const note = await git(source, "notes", `--ref=${NOTES_REF}`, "show", commit);
  const cleaned = note
    .split("\n")
    .filter((line) => line.length > 0 && !line.includes(forged))
    .join("\n");
  await writeFile(join(source, "clean.jsonl"), `${cleaned}\n`, "utf8");
  await git(source, "notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", join(source, "clean.jsonl"), commit);
  await rm(join(source, "clean.jsonl"), { force: true });

  await reveries.recordLineage({
    kind: "preserve",
    parent,
    commit,
    from: ["mod"],
    to: ["moved"],
    semantic: {
      driving_event: "The module was renamed and edited in one change.",
      decision: "Pair the two subtrees because the intent is unchanged.",
      impact: "History and continuity follow the rename.",
      recurrence_control: "The forged-coordinate fixture asserts a bound edge passes.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: objectId(moved), id: recorded.record.id });
  assert.equal((await reveries.checkCommit(commitId(commit))).ok, true);

  const fixedNotes = await git(source, "rev-parse", "refs/notes/reveries");
  await git(source, "push", "origin", "main:refs/heads/proposed2", "refs/notes/reveries:refs/notes/proposed2");
  const accepted = await checkReceive(bare, {
    updates: [
      { ref: "refs/heads/main", oldObject: objectId(publishedTip), newObject: objectId(newTip) },
      { ref: NOTES_REF, oldObject: objectId(publishedNotes), newObject: objectId(fixedNotes) },
    ],
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));
});

// --- Transport and determinism -------------------------------------------------

test("occurrence and lineage records survive canonical union and strict re-parse", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const occurrence = await reveries.recordOccurrence({
    path: "vendor/left-pad.js",
    revision: "HEAD",
    semantic: {
      v: 1,
      occurrence: undefined as never,
      driving_event: "The vendored copy is regenerated.",
      decision: "Treat it as generated.",
      impact: "Edits are overwritten.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  const view = await reveries.loadEvidenceSnapshot({});
  const record = view.entries.flatMap((entry) => entry.records)
    .find((candidate) => candidate.type === "occurrence");
  assert.ok(record !== undefined);
  const line = canonicalRecord(record);
  // A replica union keeps the exact canonical bytes and identity.
  const union = unionFacts(
    view.entries.flatMap((entry) => [...entry.records]),
    view.entries.flatMap((entry) => [...entry.records]),
  );
  const parsed = parseNote(union.map(canonicalRecord).join(""), "strict", {
    hashObject: (bytes) => reveries.repository.hashObjectSync(bytes),
  });
  assert.ok(parsed.records.some((entry) => entry.type === "occurrence" && entry.id === occurrence.record.id));
  assert.ok(parsed.records.some((entry) => canonicalRecord(entry) === line));
  assert.doesNotThrow(() => validateNote(parsed.records, {
    hashObject: (bytes) => reveries.repository.hashObjectSync(bytes),
  }));
});

test("recording the same occurrence and edge twice is idempotent", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const first = await reveries.recordOccurrence({
    path: "vendor/left-pad.js",
    revision: "HEAD",
    semantic: {
      v: 1,
      occurrence: undefined as never,
      driving_event: "The vendored copy is regenerated.",
      decision: "Treat it as generated.",
      impact: "Edits are overwritten.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  const second = await reveries.recordOccurrence({
    path: "vendor/left-pad.js",
    revision: "HEAD",
    semantic: {
      v: 1,
      occurrence: undefined as never,
      driving_event: "The vendored copy is regenerated.",
      decision: "Treat it as generated.",
      impact: "Edits are overwritten.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });
  assert.equal(second.record.id, first.record.id);
  assert.equal(canonicalRecord(second.record), canonicalRecord(first.record));
  // The repository appends the same canonical line again, which is what every
  // other record type does; strict validation and the projection both count it
  // as one decision.
  const note = await reveries.repository.readNoteFromRef("refs/notes/reveries", first.object);
  const lines = (note ?? "").trimEnd().split("\n");
  assert.ok(lines.length >= 1);
  assert.equal(new Set(lines).size, 1, "every appended line is byte-identical");
  const parsed = parseNote(`${note ?? ""}`, "strict", {
    hashObject: (bytes) => reveries.repository.hashObjectSync(bytes),
  });
  assert.equal(parsed.records.filter((record) => record.type === "occurrence").length, 2);
});

test("an occurrence whose coordinate does not resolve is refused", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const shared = (await reveries.repository.resolveSubject({ path: "src/left-pad.js", revision: "HEAD" })).object;
  const wrongSubject = (await reveries.repository.resolveSubject({ path: "top.txt", revision: "HEAD" })).object;
  const record = createOccurrence(
    {
      v: 1,
      occurrence: {
        commit: await reveries.repository.resolveCommit("HEAD"),
        path: "src/left-pad.js",
        subject: wrongSubject,
      },
      driving_event: "A coordinate that claims the wrong content.",
      decision: "Point the record at the wrong subject.",
      impact: "Validation must refuse it.",
      recurrence_control: "The coordinate fixture asserts the refusal.",
      alternatives: [],
      sources: [],
    },
    metadata,
    (bytes) => reveries.repository.hashObjectSync(bytes),
  );
  await assert.rejects(
    reveries.mutateNotes(async (notes) => {
      await notes.append(shared, canonicalRecord(record));
    }),
    /names subject|does not resolve|holds/,
  );
});

test("a correction supersedes an occurrence", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });
  const occurrence = await reveries.recordOccurrence({
    path: "mod",
    revision: "HEAD",
    semantic: {
      v: 1,
      occurrence: undefined as never,
      driving_event: "This occurrence needs a narrower statement.",
      decision: "State it for this occurrence only.",
      impact: "Later occurrences are unaffected.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  await reveries.recordCorrection({
    object: occurrence.object,
    correction: {
      v: 1,
      driving_event: "The original occurrence statement was too broad.",
      decision: "Correct it because the vendored copy is generated separately.",
      impact: "The corrected record replaces the original occurrence.",
      recurrence_control: "The correction fixture asserts the original is historical.",
      alternatives: [],
      sources: [],
      supersedes: [occurrence.record.id],
    },
    metadata,
  });
  const shown = await reveries.show({ target: "mod", revision: "HEAD" });
  assert.equal(shown.occurrences.some((entry) => entry.record.id === occurrence.record.id), false);
  const corrected = await reveries.show({ target: "mod", revision: "HEAD", includeRedacted: true });
  assert.ok(corrected.records.some((entry) => "id" in entry && entry.id === occurrence.record.id));
  assert.ok(recorded.record.id.length > 0);
});

async function setupBare(): Promise<{ readonly source: string; readonly bare: string }> {
  const root = await mkdtemp(join(tmpdir(), "reveries-lineage-receive-"));
  temporaryRepositories.push(root);
  const source = join(root, "source");
  const bare = join(root, "remote.git");
  await mkdir(source, { recursive: true });
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Reveries Test");
  await git(source, "config", "user.email", "reveries@example.com");
  await git(root, "init", "--bare", bare);
  await git(source, "remote", "add", "origin", bare);
  await mkdir(join(source, "mod"), { recursive: true });
  await writeFile(join(source, "mod/a.txt"), "alpha\n", "utf8");
  await writeFile(join(source, "top.txt"), "top\n", "utf8");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");
  return { source, bare };
}

// --- Review follow-ups: history robustness, staged rejection, record-time authority, redaction ---

test("history of a deleted lineage path starts from its last extant coordinate", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });
  await git(directory, "mv", "mod", "moved");
  await writeFile(join(directory, "moved/a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "rename and edit the module");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  await reveries.summarize({ commit, summary: summary() });
  await reveries.recordLineage({
    kind: "preserve",
    parent,
    commit: String(commit),
    from: ["mod"],
    to: ["moved"],
    semantic: {
      driving_event: "The module moved and changed in one commit.",
      decision: "Pair the two subtrees because the layout decision still holds.",
      impact: "A history walk of the new path reaches the old one.",
      recurrence_control: "The deleted-path history fixture asserts no throw.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  // Delete the path at HEAD. History must not try to resolve HEAD:moved and
  // lose the lineage trail: start at the newest commit where the coordinate
  // existed, then follow the explicit edge backwards.
  await git(directory, "rm", "-r", "moved");
  await git(directory, "commit", "-m", "delete moved");
  const history = await reveries.history("moved");
  assert.ok(history.some((entry) => entry.path === "moved"));
  assert.ok(history.some((entry) => entry.path === "mod" && entry.viaLineage !== undefined));
});

test("history follows a lineage chain across an unrelated later commit", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });
  const edgeSemantic = (label: string) => ({
    driving_event: `The module moved (${label}).`,
    decision: "Pair the subtrees because the layout decision still holds.",
    impact: "History follows the chain instead of stopping at a rename.",
    recurrence_control: "The chained-history fixture asserts both links survive.",
    alternatives: [],
    sources: [],
  });

  await git(directory, "mv", "mod", "mid");
  await writeFile(join(directory, "mid/a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "first move");
  const first = commitId(await git(directory, "rev-parse", "HEAD"));
  await reveries.summarize({ commit: first, summary: summary() });
  const edge1 = await reveries.recordLineage({
    kind: "preserve", parent: `${first}~1`, commit: String(first),
    from: ["mod"], to: ["mid"], semantic: edgeSemantic("first"), metadata,
  });

  await reveries.recordNew({ path: "mid", revision: "HEAD", semantic: universal, metadata });
  await git(directory, "mv", "mid", "final");
  await writeFile(join(directory, "final/a.txt"), "alpha changed again\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "second move");
  const second = commitId(await git(directory, "rev-parse", "HEAD"));
  await reveries.summarize({ commit: second, summary: summary() });
  const edge2 = await reveries.recordLineage({
    kind: "preserve", parent: `${second}~1`, commit: String(second),
    from: ["mid"], to: ["final"], semantic: edgeSemantic("second"), metadata,
  });

  // An unrelated later commit must not drop the explicit trail.
  await writeFile(join(directory, "top.txt"), "top changed\n", "utf8");
  await git(directory, "add", "top.txt");
  await git(directory, "commit", "-m", "unrelated change");

  const history = await reveries.history("final");
  const via = history.filter((entry) => entry.viaLineage !== undefined);
  assert.deepEqual(via.map((entry) => entry.viaLineage).sort(), [edge1.record.id, edge2.record.id].sort());
  assert.deepEqual(via.map((entry) => entry.path).sort(), ["mid", "mod"]);
});

test("occurrence record rejects staged content with a clear route", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await writeFile(join(directory, "top.txt"), "top changed\n", "utf8");
  await git(directory, "add", "top.txt");
  await assert.rejects(
    reveries.recordOccurrence({
      path: "top.txt",
      revision: "index",
      semantic: {
        v: 1,
        occurrence: undefined as never,
        driving_event: "Staged content has no commit coordinate.",
        decision: "Refuse it rather than record a coordinate the repository cannot resolve.",
        impact: "Operators commit first, then record at that commit.",
        recurrence_control: "The staged-occurrence fixture asserts the refusal.",
        alternatives: [],
        sources: [],
      },
      metadata,
    }),
    /needs a commit, and staged content has none/,
  );
  const captured = captureIo(directory);
  const code = await runCli(
    ["occurrence", "record", "top.txt", "--staged", "--driving-event", "e", "--decision", "d", "--impact", "i"],
    captured.io,
  );
  assert.equal(code, 3);
  assert.match(captured.stderr(), /--staged is not accepted/);
});

test("a preserve edge for a pure rename is refused at record time", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  await reveries.recordNew({ path: "top.txt", revision: "HEAD", semantic: universal, metadata });
  await git(directory, "mv", "top.txt", "renamed.txt");
  await git(directory, "commit", "-m", "pure rename");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  await reveries.summarize({ commit, summary: summary() });

  await assert.rejects(
    reveries.recordLineage({
      kind: "preserve",
      parent,
      commit: String(commit),
      from: ["top.txt"],
      to: ["renamed.txt"],
      semantic: {
        driving_event: "The file was renamed without edits.",
        decision: "Pair it anyway, which the record gate must refuse.",
        impact: "The refusal keeps a passing check passing.",
        recurrence_control: "The pure-rename fixture asserts record-time refusal.",
        alternatives: [],
        sources: [],
      },
      metadata,
    }),
    /needs no lineage edge/,
  );
  assert.equal((await reveries.checkCommit(commit)).ok, true);
});

test("a redaction hides a lineage edge from show", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  await reveries.recordNew({ path: "mod", revision: "HEAD", semantic: universal, metadata });
  await git(directory, "mv", "mod", "moved");
  await writeFile(join(directory, "moved/a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "rename and edit the module");
  const commit = commitId(await git(directory, "rev-parse", "HEAD"));
  const parent = await git(directory, "rev-parse", "HEAD^");
  await reveries.summarize({ commit, summary: summary() });
  const edge = await reveries.recordLineage({
    kind: "preserve",
    parent,
    commit: String(commit),
    from: ["mod"],
    to: ["moved"],
    semantic: {
      driving_event: "The module moved and changed in one commit.",
      decision: "Pair the two subtrees because the layout decision still holds.",
      impact: "Show lists the edge until it is redacted.",
      recurrence_control: "The redacted-edge fixture asserts show hides it.",
      alternatives: [],
      sources: [],
    },
    metadata,
  });

  const before = await reveries.show({ target: "moved", revision: "HEAD" });
  assert.ok(before.lineage.some((record) => record.id === edge.record.id));
  await reveries.recordRedaction({
    object: edge.commit,
    target: edge.record.id,
    reason: "The pairing was wrong; hide it from display.",
    metadata,
  });
  const after = await reveries.show({ target: "moved", revision: "HEAD" });
  assert.equal(after.lineage.some((record) => record.id === edge.record.id), false);
  const withRedacted = await reveries.show({ target: "moved", revision: "HEAD", includeRedacted: true });
  assert.ok(withRedacted.lineage.some((record) => record.id === edge.record.id));
});
