import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { runCli, type CliIo } from "../src/cli.ts";
import { Reveries } from "../src/operations.ts";
import {
  canonicalRecord,
  commitId,
  createReverie,
  objectId,
  validateNote,
  type ReverieInput,
  type ReverieMetadata,
  type ReveriesInit,
  type SessionSummary,
  type TransitionCausal,
  type TransitionMetadata,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-tree-reverie-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await mkdir(join(directory, "mod", "inner"), { recursive: true });
  await writeFile(join(directory, "mod", "a.txt"), "alpha\n", "utf8");
  await writeFile(join(directory, "mod", "inner", "b.txt"), "beta\n", "utf8");
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

const semantic: ReverieInput = {
  v: 1,
  driving_event: "The module layout forces every consumer to update together.",
  decision: "Keep the module directory composition because its split layout matches the loader.",
  impact: "Every checkout with this exact subtree shares the same loading behavior.",
  recurrence_control: "Tree fixtures fail when subtree evidence stops resolving.",
  alternatives: ["Flatten the module"],
  sources: [],
  supersedes: [],
};

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:tree-reverie",
  created_at: "2026-10-02T00:00:00Z",
};

function summary(): SessionSummary {
  return {
    v: 1,
    type: "session-summary",
    author_email: "reveries@example.com",
    session: "codex:tree-reverie",
    created_at: "2026-10-02T00:05:00Z",
    entries: [{
      driving_event: "The commit changed tracked content.",
      decision: "Summarize the commit because descendants require a causal account.",
      impact: "Reviewers read the change beside its causal account.",
      recurrence_control: "The commit check requires one summary per descendant commit.",
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
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
    created_at: "2026-10-02T00:00:00Z",
  };
}

async function adopt(directory: string, reveries: Reveries): Promise<string> {
  const adoption = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit: adoption, summary: summary() });
  await reveries.attachInitialization({ commit: adoption, record: initialization() });
  return adoption;
}

const transitionCausal: TransitionCausal = {
  driving_event: "The test needs a transition record on the same tree as a reverie.",
  decision: "Record a root transition because coexistence must stay readable.",
  impact: "Transition and reverie evidence share one tree note without conflict.",
  recurrence_control: "The coexistence fixture fails when placement rejects either record.",
  alternatives: [],
  sources: [],
  reveries: [],
  retirements: [],
};

const transitionMetadata: TransitionMetadata = {
  author_email: "reveries@example.com",
  session: "codex:tree-reverie",
  created_at: "2026-10-02T00:06:00Z",
};

test("a directory records a tree reverie that show resolves by path and by tree OID", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });
  assert.deepEqual(recorded.paths, ["mod"]);

  const byPath = await reveries.show({ target: "mod", revision: "HEAD" });
  assert.equal(byPath.objectType, "tree");
  assert.deepEqual(byPath.paths, ["mod"]);
  assert.equal(byPath.active[0]?.id, recorded.record.id);

  const byOid = await reveries.show({ target: String(recorded.object), revision: "HEAD" });
  assert.equal(byOid.object, recorded.object);
  assert.equal(byOid.active[0]?.id, recorded.record.id);
});

test("a session summary on a tree is strictly rejected as a non-tree protocol record", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });
  const tree = String(recorded.object);

  const existing = await git(directory, "notes", "--ref=refs/notes/reveries", "show", tree);
  const poisoned = `${existing}\n${canonicalRecord(summary())}`;
  const poisonedPath = join(directory, "poisoned-note.jsonl");
  await writeFile(poisonedPath, poisoned, "utf8");
  try {
    await git(directory, "notes", "--ref=refs/notes/reveries", "add", "-f", "-F", poisonedPath, tree);
  } finally {
    await rm(poisonedPath, { force: true });
  }

  await assert.rejects(
    reveries.mutateNotes(async () => {}),
    /non-tree protocol record/,
  );
});

test("an unchanged subtree move retains applicability with no continuity obligation", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });

  await git(directory, "mv", "mod", "moved");
  await git(directory, "commit", "-m", "move module without changes");
  const commit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: summary() });

  const check = await reveries.checkCommit(commit);
  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));

  const shown = await reveries.show({ target: "moved", revision: "HEAD" });
  assert.equal(shown.active[0]?.id, recorded.record.id);

  const hits = await reveries.search({ query: "loader" });
  const treeHits = hits.filter((hit) => hit.object === recorded.object);
  assert.equal(treeHits.length, 1);
  assert.deepEqual(treeHits[0]?.paths, ["moved"]);
});

test("a descendant edit creates a tree continuity obligation cleared by continue", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });
  const predecessor = String(recorded.object);

  await writeFile(join(directory, "mod", "a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "mod/a.txt");

  const blocked = await reveries.checkStaged();
  assert.equal(blocked.ok, false);
  assert.match(blocked.diagnostics.join("\n"), new RegExp(`${recorded.record.id} from ${predecessor}: missing-disposition`));

  const successor = (await reveries.repository.resolveSubject({ path: "mod", revision: "index" })).object;
  assert.notEqual(successor, recorded.object);
  const continued = await reveries.recordContinueToBlob({
    fromBlob: recorded.object,
    toBlob: successor,
    id: recorded.record.id,
  });
  assert.equal(continued.record.id, recorded.record.id);

  const cleared = await reveries.checkStaged();
  assert.equal(cleared.ok, true, JSON.stringify(cleared.diagnostics));
});

test("a tree reverie retires through a session summary that names the tree predecessor", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });
  const predecessor = String(recorded.object);

  await writeFile(join(directory, "mod", "a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "mod/a.txt");
  await git(directory, "commit", "-m", "change module content");
  const commit = await git(directory, "rev-parse", "HEAD");

  const retiring = summary();
  retiring.entries[0]!.retirements = [{
    reverie: recorded.record.id,
    from_blob: recorded.object,
    reason: "The module composition changed and the old layout decision no longer applies.",
  }];
  await reveries.summarize({ commit, summary: retiring });

  const check = await reveries.checkCommit(commit);
  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));
  assert.match(predecessor, /^[0-9a-f]{40}$/);
});

test("a tree source kind validates strictly without changing existing source bytes", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });
  const tree = String(recorded.object);

  const withTreeSource: ReverieInput = {
    ...semantic,
    decision: "Reference the exact subtree as provenance for this file decision.",
    sources: [{ relation: "derived-from", kind: "tree", ref: tree }],
  };
  const record = createReverie(
    withTreeSource,
    metadata,
    (bytes) => reveries.repository.hashObjectSync(bytes),
  );
  const validated = validateNote([record], {
    hashObject: (bytes) => reveries.repository.hashObjectSync(bytes),
  });
  assert.equal(validated.length, 1);

  const malformed: ReverieInput = {
    ...semantic,
    sources: [{ relation: "derived-from", kind: "tree", ref: "not-an-object-id" }],
  };
  assert.throws(
    () => createReverie(malformed, metadata, (bytes) => reveries.repository.hashObjectSync(bytes)),
    /Invalid Git object ID/,
  );
});

test("a missing tree source fails closed instead of validating silently", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const missing = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(await reveries.repository.treeExists(missing as never), false);
  const withMissingSource: ReverieInput = {
    ...semantic,
    decision: "Cite a subtree that does not exist locally.",
    sources: [{ relation: "derived-from", kind: "tree", ref: missing }],
  };
  await assert.rejects(
    reveries.recordNew({ path: "top.txt", revision: "HEAD", semantic: withMissingSource, metadata }),
    /Broken local tree source/,
  );
});

test("a transition summary and a reverie coexist on one tree note", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const rootTree = await reveries.repository.treeForCommit(await reveries.repository.resolveCommit("HEAD"));
  await reveries.recordTransition({ parents: [], result: rootTree, causal: transitionCausal, metadata: transitionMetadata });

  const coexistence: ReverieInput = {
    ...semantic,
    decision: "Keep the exact repository composition for reproducible fixtures.",
  };
  const record = createReverie(
    coexistence,
    metadata,
    (bytes) => reveries.repository.hashObjectSync(bytes),
  );
  await reveries.mutateNotes(async (notes) => {
    await notes.append(rootTree, canonicalRecord(record));
  });
  await reveries.mutateNotes(async () => {});
  const shown = await reveries.show({ target: String(rootTree), revision: "HEAD" });
  assert.ok(shown.records.some((entry) => entry.type === "transition-summary"));
  assert.ok(shown.records.some((entry) => entry.type === "reverie"));
});

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

test("recording discloses universal tree applicability", async () => {
  const directory = await createRepository();
  const captured = captureIo(directory);
  const exitCode = await runCli([
    "record", "new", "mod",
    "--driving-event", semantic.driving_event,
    "--decision", semantic.decision,
    "--impact", semantic.impact,
    "--recurrence-control", semantic.recurrence_control!,
  ], captured.io);
  assert.equal(exitCode, 0);
  assert.match(captured.stdout(), /Applies to every occurrence of the exact recorded content/);
});

test("a root-tree reverie stays in default search and obliges descendant edits", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const rootTree = await reveries.repository.treeForCommit(await reveries.repository.resolveCommit("HEAD"));
  const record = createReverie(
    { ...semantic, decision: "Keep the exact repository composition for reproducible fixtures." },
    metadata,
    (bytes) => reveries.repository.hashObjectSync(bytes),
  );
  await reveries.mutateNotes(async (notes) => {
    await notes.append(rootTree, canonicalRecord(record));
  });

  const shown = await reveries.show({ target: String(rootTree), revision: "HEAD" });
  assert.equal(shown.objectType, "tree");
  assert.deepEqual(shown.paths, ["."]);
  assert.equal(shown.active[0]?.id, record.id);

  const hits = await reveries.search({ query: "reproducible fixtures" });
  const rootHits = hits.filter((hit) => hit.object === rootTree);
  assert.equal(rootHits.length, 1);
  assert.deepEqual(rootHits[0]?.paths, ["."]);

  await writeFile(join(directory, "mod", "a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "mod/a.txt");
  const blocked = await reveries.checkStaged();
  assert.equal(blocked.ok, false);
  assert.match(
    blocked.diagnostics.join("\n"),
    new RegExp(`${record.id} from ${String(rootTree)}: missing-disposition`),
  );

  const successor = await reveries.repository.indexTree();
  assert.notEqual(successor, rootTree);
  const continued = await reveries.recordContinueToBlob({
    fromBlob: rootTree,
    toBlob: successor,
    id: record.id,
  });
  assert.equal(continued.record.id, record.id);
  const cleared = await reveries.checkStaged();
  assert.equal(cleared.ok, true, JSON.stringify(cleared.diagnostics));
});

test("a staged rename-plus-edit requires retirement even when continued elsewhere", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });

  await git(directory, "mv", "mod", "moved");
  await writeFile(join(directory, "moved", "a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "-A");

  const unmappedBlocked = await reveries.checkStaged();
  assert.equal(unmappedBlocked.ok, false);
  assert.match(unmappedBlocked.diagnostics.join("\n"), /missing-disposition/);

  // A continued record on the unrelated reachable tree is not authority until
  // RVR-014 lineage: the obligation stands.
  const successor = (await reveries.repository.resolveSubject({ path: "moved", revision: "index" })).object;
  await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: successor, id: recorded.record.id });
  const stillBlocked = await reveries.checkStaged();
  assert.equal(stillBlocked.ok, false);
  assert.match(stillBlocked.diagnostics.join("\n"), /missing-disposition/);

  // An explicit tree map is refused honestly instead of passing locally while
  // outgoing/receive would fail.
  await assert.rejects(
    reveries.checkStaged(new Map([["mod", "moved"]])),
    /maps file \(blob\) paths only/,
  );
});

test("deleting an annotated subtree while its record continues elsewhere still obliges", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });

  // Reviewer repro: delete annotated `mod`, edit unrelated `vendor`, carry the
  // same record there. The reachable same-ID record must not green the check.
  await git(directory, "rm", "-r", "mod");
  await mkdir(join(directory, "vendor"), { recursive: true });
  await writeFile(join(directory, "vendor", "file.txt"), "vendor\n", "utf8");
  await git(directory, "add", "-A");
  const vendorTree = (await reveries.repository.resolveSubject({ path: "vendor", revision: "index" })).object;
  await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: vendorTree, id: recorded.record.id });
  await git(directory, "commit", "-m", "delete the module, touch vendor");
  const commit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: summary() });

  const blocked = await reveries.checkCommit(commit);
  assert.equal(blocked.ok, false);
  assert.match(
    blocked.diagnostics.join("\n"),
    new RegExp(`${recorded.record.id} from ${String(recorded.object)}: missing-disposition`),
  );

  const retiring = summary();
  retiring.entries[0]!.retirements = [{
    reverie: recorded.record.id,
    from_blob: recorded.object,
    reason: "The module was deleted; its layout decision no longer applies anywhere.",
  }];
  await reveries.summarize({ commit, summary: retiring, replace: true });
  const retired = await reveries.checkCommit(commit);
  assert.equal(retired.ok, true, JSON.stringify(retired.diagnostics));
});

test("an unchanged copy at two paths shares evidence with no spurious obligation", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });

  cpSync(join(directory, "mod"), join(directory, "modcopy"), { recursive: true });
  await git(directory, "add", "-A");

  const staged = await reveries.checkStaged();
  assert.equal(staged.ok, true, JSON.stringify(staged.diagnostics));

  await git(directory, "commit", "-m", "copy the module unchanged");
  const commit = await git(directory, "rev-parse", "HEAD");
  await reveries.summarize({ commit, summary: summary() });
  const check = await reveries.checkCommit(commit);
  assert.equal(check.ok, true, JSON.stringify(check.diagnostics));

  for (const path of ["mod", "modcopy"]) {
    const shown = await reveries.show({ target: path, revision: "HEAD" });
    assert.equal(shown.active[0]?.id, recorded.record.id);
  }
  const hits = await reveries.search({ query: "loader" });
  const treeHits = hits.filter((hit) => hit.object === recorded.object);
  assert.equal(treeHits.length, 1);
  assert.deepEqual([...treeHits[0]?.paths ?? []].sort(), ["mod", "modcopy"]);
});

test("a predecessor tree never pairs to a blob carrying the same reverie", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });

  // The same decision continued onto a file changes nothing for the tree
  // predecessor: only a same-path tree successor or a causal retirement
  // clears the obligation, and no same-type confusion is possible.
  const topBlob = await reveries.repository.resolvePath({ path: "top.txt", revision: "index" });
  await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: topBlob, id: recorded.record.id });

  await writeFile(join(directory, "mod", "a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "mod/a.txt");
  const check = await reveries.checkStaged();
  assert.equal(check.ok, false);
  assert.match(check.diagnostics.join("\n"), /missing-disposition/);
});

test("unannotated subtrees cost no note reads during a tree continuity check", async () => {
  const directory = await createRepository();
  for (let index = 0; index < 150; index += 1) {
    const dir = join(directory, `plain-${index}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "file.txt"), `plain ${index}\n`, "utf8");
  }
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "many unannotated directories");
  const reveries = await Reveries.open(directory);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });

  await writeFile(join(directory, "mod", "a.txt"), "alpha changed\n", "utf8");
  await git(directory, "add", "mod/a.txt");

  const repository = reveries.repository;
  const original = repository.readNoteFromRef.bind(repository);
  let noteReads = 0;
  repository.readNoteFromRef = async (...args: Parameters<typeof original>) => {
    noteReads += 1;
    return original(...args);
  };
  try {
    const check = await reveries.checkStaged();
    assert.equal(check.ok, false);
    assert.match(check.diagnostics.join("\n"), new RegExp(`${recorded.record.id} from ${String(recorded.object)}: missing-disposition`));
  } finally {
    repository.readNoteFromRef = original;
  }
  // Note I/O stays bounded by annotated subjects, not by subtree count:
  // 150 unannotated directories must not mean 150 note reads.
  assert.ok(noteReads < 50, `expected bounded note reads, observed ${noteReads}`);
});

test("replacing a directory with a file at the same path requires retirement", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  await adopt(directory, reveries);
  const recorded = await reveries.recordNew({ path: "mod", revision: "HEAD", semantic, metadata });

  // Same-path successor candidates are trees only: the new blob at `mod`
  // must not pair with the old annotated subtree.
  await git(directory, "rm", "-r", "mod");
  await writeFile(join(directory, "mod"), "now a file\n", "utf8");
  await git(directory, "add", "-A");

  // Even the same record continued onto the replacement file is not a tree
  // successor: the obligation stands until causal retirement.
  const fileBlob = await reveries.repository.resolvePath({ path: "mod", revision: "index" });
  await reveries.recordContinueToBlob({ fromBlob: recorded.object, toBlob: fileBlob, id: recorded.record.id });
  const staged = await reveries.checkStaged();
  assert.equal(staged.ok, false);
  assert.match(
    staged.diagnostics.join("\n"),
    new RegExp(`${recorded.record.id} from ${String(recorded.object)}: missing-disposition`),
  );

  await git(directory, "commit", "-m", "replace the module directory with a file");
  const commit = await git(directory, "rev-parse", "HEAD");
  const retiring = summary();
  retiring.entries[0]!.retirements = [{
    reverie: recorded.record.id,
    from_blob: recorded.object,
    reason: "The module directory became a single file; the layout decision no longer applies.",
  }];
  await reveries.summarize({ commit, summary: retiring });
  const retired = await reveries.checkCommit(commit);
  assert.equal(retired.ok, true, JSON.stringify(retired.diagnostics));
});
