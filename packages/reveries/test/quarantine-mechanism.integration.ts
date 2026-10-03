import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCli, type CliIo } from "../src/cli.ts";
import { GitRepository, hashBlobContent, NOTES_REF, QUARANTINE_REF_PREFIX } from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import { canonicalRecord, createReverie, type ObjectId } from "../src/protocol.ts";

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

// --- Inspecting a quarantine (RVR-030) ---------------------------------------
//
// A quarantine ref lives at `refs/reveries/quarantine/<remote>/<oid>`, which is
// outside `refs/notes/`. `git notes --ref=<that>` does not reject the name — it
// resolves `refs/notes/refs/reveries/quarantine/<remote>/<oid>` and reports no
// note for a candidate that is present and intact. The write is at the canonical
// ref and the read is at a different one, in the same direction, so nothing
// fails loudly: an operator inspecting a quarantine during an incident concludes
// the quarantine is empty. These tests pin the supported inspection path so the
// broken command is never the only one available.

/** Capture CLI output without a subprocess, the way the command layer reads it. */
function captureIo(cwd: string): { readonly io: CliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let out = "";
  let error = "";
  return {
    io: {
      cwd,
      stdin: async () => "",
      stdout: (text) => { out += text; },
      stderr: (text) => { error += text; },
      environment: {},
    },
    stdout: () => out,
    stderr: () => error,
  };
}

test("git notes --ref cannot read a quarantine, which is why a reader exists", async () => {
  // The defect itself, asserted so the reason for the inspection command cannot
  // be quietly forgotten: the bytes are there, and the naive read misses them.
  const directory = await mkdtemp(join(tmpdir(), "reveries-quarantine-namespace-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine("Evidence that must remain inspectable in quarantine."));
  });
  const candidate = (await repository.notesTip()) as ObjectId;
  const ref = await repository.quarantineNotes("vendor", candidate);
  assert.equal(ref, `${QUARANTINE_REF_PREFIX}vendor/${candidate}`);

  // `git notes --ref=` on the canonical ref does not fail. It resolves the
  // shadow ref `refs/notes/refs/reveries/...`, finds nothing there, exits 0, and
  // prints nothing. That is the whole of RVR-030: the write is at one ref, the
  // read is at another, and the read reports success while reporting nothing.
  // An operator inspecting a quarantine concludes there is nothing to inspect.
  const naive = await git(directory, "notes", `--ref=${ref}`, "list");
  assert.equal(naive, "", "git notes --ref= reports no notes for a present candidate, and exits 0");

  // Meanwhile the bytes really are there, reachable as Git objects at the
  // canonical ref, which is what the supported reader uses.
  assert.match(
    (await repository.readNoteAt(candidate, blob)) ?? "",
    /inspectable in quarantine/,
  );
  assert.equal((await repository.listNotesAt(candidate)).length, 1, "the candidate does hold a note");
});

test("a repository with no quarantine reports that, and it is not a failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reveries-quarantine-empty-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");

  const json = captureIo(directory);
  assert.equal(await runCli(["ledger", "quarantine", "list", "--json"], json.io), 0, json.stderr());
  const parsed = JSON.parse(json.stdout()) as { result: { quarantines: readonly unknown[] } };
  assert.deepEqual(parsed.result.quarantines, []);

  // An empty quarantine is the ordinary state of a repository that has never
  // refused evidence. Reporting it as damage would train operators to ignore it.
  const human = captureIo(directory);
  assert.equal(await runCli(["ledger", "quarantine", "list"], human.io), 0, human.stderr());
  assert.match(human.stdout(), /No quarantined/);
});

test("a quarantine is listed and read through the supported accessor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reveries-quarantine-read-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine("Quarantined evidence stays readable by an operator."));
  });
  const candidate = (await repository.notesTip()) as ObjectId;
  const ref = await repository.quarantineNotes("vendor", candidate);

  const listed = await repository.quarantinedCandidates();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.ref, ref);
  // The remote is recovered from the ref, so a name containing a slash is not
  // truncated to its first segment.
  assert.equal(listed[0]?.remote, "vendor");
  assert.equal(listed[0]?.candidate, candidate);

  const list = captureIo(directory);
  assert.equal(await runCli(["ledger", "quarantine", "list", "--json"], list.io), 0, list.stderr());
  assert.match(list.stdout(), new RegExp(ref.replace(/[/.]/g, "\\$&")));

  // The bytes come back, which is what an operator actually needs during an
  // incident: the evidence is preserved and readable without being canonical.
  const show = captureIo(directory);
  assert.equal(await runCli(["ledger", "quarantine", "show", ref, "--json"], show.io), 0, show.stderr());
  assert.match(show.stdout(), /readable by an operator/);
  assert.match(show.stdout(), /vendor/);
  // Inspecting a quarantine must not move canonical state. This test wrote the
  // canonical notes itself, so the assertion is that the tip is exactly what it
  // was before any inspection ran.
  assert.equal(await repository.notesTip(), candidate);
});

test("a quarantine ref with a slash remote keeps the whole name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reveries-quarantine-slash-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine("A slash remote's quarantine is still attributable."));
  });
  const candidate = (await repository.notesTip()) as ObjectId;
  const ref = await repository.quarantineNotes("team/vendor", candidate);

  const listed = await repository.quarantinedCandidates();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.ref, ref);
  assert.equal(
    listed[0]?.remote,
    "team/vendor",
    "the remote is everything between the prefix and the object ID",
  );
});

test("show refuses the shadow ref name instead of reading a different ref", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reveries-quarantine-shadow-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "state.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blob, reverieLine("Held evidence."));
  });
  const candidate = (await repository.notesTip()) as ObjectId;
  const ref = await repository.quarantineNotes("vendor", candidate);

  // The shadow name is the exact ref `git notes --ref=` would have resolved.
  // Accepting it would make the failure mode this command exists to remove
  // reachable again, and would report bytes that are not the quarantine asked
  // about.
  const shadow = captureIo(directory);
  assert.equal(await runCli(["ledger", "quarantine", "show", `refs/notes/${ref}`], shadow.io), 3);
  assert.match(shadow.stderr(), /not a quarantine/);

  const absent = captureIo(directory);
  assert.equal(
    await runCli(["ledger", "quarantine", "show", `${QUARANTINE_REF_PREFIX}vendor/${"0".repeat(40)}`], absent.io),
    3,
  );
  assert.match(absent.stderr(), /No quarantine at/);
});

test("the command layer never shells out to git notes for a quarantine", async () => {
  // A guard rather than a behavioural test: the hazard is a specific argv, and
  // the cheapest durable defence is asserting the source cannot build one. The
  // command layer must never invoke `git notes` at all — every note read goes
  // through an accessor. The help text may still *mention* the broken command,
  // because naming the hazard is how an operator learns not to reach for it.
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /run\(\s*\[\s*"notes"/, "the CLI must not build a git notes argv");
  assert.doesNotMatch(source, /execFileAsync\(\s*"git",\s*\[\s*"notes"/);
  // A quarantine ref must never be paired with `--ref=`: that is the exact
  // combination that silently reads a different ref.
  assert.doesNotMatch(source, /--ref=\$\{?QUARANTINE_REF_PREFIX/);
  assert.doesNotMatch(source, /--ref=refs\/reveries/);
});
