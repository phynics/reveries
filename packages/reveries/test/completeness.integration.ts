import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { GitRepository } from "../src/git.ts";
import { IncompleteEvidenceError, Reveries } from "../src/operations.ts";
import { handleHookEvent } from "../src/hooks.ts";
import { checkReceive } from "../src/receive.ts";
import { objectId, type ObjectId, type ReverieInput, type ReverieMetadata } from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

const semantic: ReverieInput = {
  v: 1,
  driving_event: "A reader observed a missing object in an incomplete clone.",
  decision: "Report the completeness grade because absence is not authoritative without full history.",
  impact: "Search, show, and hooks refuse to claim evidence does not exist.",
  recurrence_control: "The completeness fixtures cover shallow and partial clones.",
  alternatives: ["Treat every missing object as absent"],
  sources: [],
  supersedes: [],
};

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "codex:completeness",
  created_at: "2026-08-25T03:00:00Z",
};

interface SourceFixture {
  readonly directory: string;
  readonly oldCommit: string;
  readonly newCommit: string;
  readonly oldBlob: string;
  readonly newBlob: string;
}

async function createSource(): Promise<SourceFixture> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-complete-src-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await git(directory, "config", "uploadpack.allowFilter", "true");
  await git(directory, "config", "uploadpack.allowAnySHA1InWant", "true");
  await writeFile(
    join(directory, "AGENTS.md"),
    "<!-- reveries:begin -->\n## Reveries\n<!-- reveries:end -->\n",
    "utf8",
  );
  await writeFile(join(directory, "state.txt"), "first\n", "utf8");
  await git(directory, "add", "AGENTS.md", "state.txt");
  await git(directory, "commit", "-m", "initial");
  const oldCommit = await git(directory, "rev-parse", "HEAD");
  const oldBlob = await git(directory, "rev-parse", "HEAD:state.txt");
  await writeFile(join(directory, "state.txt"), "second\n", "utf8");
  await writeFile(join(directory, "big.bin"), `${"x".repeat(20000)}\n`, "utf8");
  await git(directory, "add", "state.txt", "big.bin");
  await git(directory, "commit", "-m", "second");
  const newCommit = await git(directory, "rev-parse", "HEAD");
  const newBlob = await git(directory, "rev-parse", "HEAD:state.txt");
  const reveries = await Reveries.open(directory);
  await reveries.recordNew({ path: "state.txt", revision: "HEAD", semantic, metadata });
  return { directory, oldCommit, newCommit, oldBlob, newBlob };
}

async function cloneRepository(
  source: string,
  name: string,
  args: readonly string[],
  options: { readonly fetchNotesFilter?: string | null; readonly keepOrigin?: boolean } = {},
): Promise<string> {
  const directory = join(await mkdtemp(join(tmpdir(), "reveries-complete-")), name);
  temporaryRepositories.push(directory);
  await execFileAsync(
    "git",
    ["-c", "protocol.version=2", "clone", ...args, `file://${source}`, directory],
    { encoding: "utf8" },
  );
  if (options.fetchNotesFilter !== undefined && options.fetchNotesFilter !== null) {
    await git(
      directory,
      "-c",
      "protocol.version=2",
      "fetch",
      "--filter=blob:none",
      "origin",
      "+refs/notes/reveries:refs/notes/reveries",
    );
  } else if (options.fetchNotesFilter === null) {
    await git(directory, "fetch", "origin", "+refs/notes/reveries:refs/notes/reveries");
  }  if (options.keepOrigin !== true) {
    await git(directory, "remote", "remove", "origin");
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("clone detectors report a complete local repository", async () => {
  const source = await createSource();
  const repository = await GitRepository.open(source.directory);
  assert.equal(await repository.isShallowRepository(), false);
  assert.equal(await repository.hasPromisorRemote(), false);
  assert.deepEqual(
    [...await repository.missingObjects([objectId(source.oldBlob), objectId(source.newBlob)])],
    [],
  );
});

test("clone detectors report shallow boundaries", async () => {
  const source = await createSource();
  const directory = await cloneRepository(source.directory, "shallow", ["--depth", "1"]);
  const repository = await GitRepository.open(directory);
  assert.equal(await repository.isShallowRepository(), true);
  assert.equal(await repository.hasPromisorRemote(), false);
});

test("clone detectors report promisor remotes and missing objects", async () => {
  const source = await createSource();
  const directory = await cloneRepository(source.directory, "partial", [
    "--filter=blob:none",
    "--no-local",
    "--no-checkout",
  ], { keepOrigin: true });
  const repository = await GitRepository.open(directory);
  assert.equal(await repository.isShallowRepository(), false);
  assert.equal(await repository.hasPromisorRemote(), true);
  // Probes must not heal the fixture: an unsuppressed batch-check would
  // lazily fetch from the intact origin, so assess through suppression.
  const suppressed = repository.withoutLazyFetch();
  const missing = await suppressed.missingObjects([objectId(source.oldBlob), objectId(source.newBlob)]);
  assert.ok(missing.has(objectId(source.oldBlob)), "old blob stays missing without lazy fetch");
  assert.ok(missing.has(objectId(source.newBlob)), "HEAD blob stays missing without checkout");
  const stillMissing = await suppressed.missingObjects([objectId(source.oldBlob)]);
  assert.ok(stillMissing.has(objectId(source.oldBlob)), "assessment itself must not materialize objects");
});

test("suppressed reads never lazily fetch from an intact promisor remote", async () => {
  const source = await createSource();
  const directory = await cloneRepository(
    source.directory,
    "nofetch",
    ["--filter=blob:none", "--no-local", "--no-checkout"],
    { keepOrigin: true },
  );
  const repository = (await GitRepository.open(directory)).withoutLazyFetch();
  assert.equal(await repository.objectExists("blob", objectId(source.oldBlob)), false);
  const stillMissing = await repository.missingObjects([objectId(source.oldBlob)]);
  assert.ok(stillMissing.has(objectId(source.oldBlob)), "suppressed read must not materialize the blob");
});

test("search reports a complete grade on a full clone", async () => {
  const source = await createSource();
  const directory = await cloneRepository(source.directory, "full", ["--no-local"], {
    fetchNotesFilter: null,
  });
  const reveries = await Reveries.open(directory);
  const result = await reveries.searchWithCompleteness({ query: "incomplete clone", all: true });
  assert.equal(result.completeness.grade, "complete");
  assert.equal(result.completeness.authoritative, true);
  assert.equal(result.hits.length, 1);
  assert.equal((await reveries.search({ query: "incomplete clone", all: true })).length, 1);
});

test("search refuses authoritative absence on a partial clone", async () => {
  const source = await createSource();
  const directory = await cloneRepository(source.directory, "partial-search", [
    "--filter=blob:none",
    "--no-local",
    "--no-checkout",
  ], { fetchNotesFilter: "blob:none", keepOrigin: true });
  const reveries = await Reveries.open(directory);
  await assert.rejects(
    reveries.search({ query: "incomplete clone", all: true }),
    (error: unknown) => {
      assert.ok(error instanceof IncompleteEvidenceError);
      assert.equal(error.completeness.grade, "promisor-object-missing");
      return true;
    },
  );
  const envelope = await reveries.searchWithCompleteness({
    query: "incomplete clone",
    all: true,
    allowIncomplete: true,
  });
  assert.equal(envelope.completeness.grade, "promisor-object-missing");
  assert.equal(envelope.completeness.authoritative, false);
  assert.ok(envelope.completeness.reasons.length > 0);
  const suppressed = (await GitRepository.open(directory)).withoutLazyFetch();
  const stillMissing = await suppressed.missingObjects([objectId(source.newBlob)]);
  assert.ok(stillMissing.has(objectId(source.newBlob)), "graded reads must not lazily fetch");
});

test("show grades unfetched notes instead of claiming absence", async () => {
  const source = await createSource();
  const directory = await cloneRepository(source.directory, "shallow-nonotes", ["--depth", "1"]);
  const reveries = await Reveries.open(directory);
  const shown = await reveries.show({ target: "state.txt", revision: "HEAD" });
  assert.deepEqual([...shown.records], []);
  assert.equal(shown.completeness.grade, "notes-unfetched");
  assert.equal(shown.completeness.authoritative, false);
});

test("show across a shallow boundary reports shallow-boundary", async () => {
  const source = await createSource();
  const directory = await cloneRepository(source.directory, "shallow-old", ["--depth", "1"]);
  const reveries = await Reveries.open(directory);
  await assert.rejects(
    reveries.show({ target: "state.txt", revision: source.oldCommit }),
    (error: unknown) => {
      assert.ok(error instanceof IncompleteEvidenceError);
      assert.equal(error.completeness.grade, "shallow-boundary");
      return true;
    },
  );
});

test("automatic hook delivery grades incomplete evidence without fetching", async () => {
  const source = await createSource();
  const withSource = {
    ...semantic,
    sources: [{ relation: "derived-from" as const, kind: "blob" as const, ref: source.oldBlob }],
  };
  const setup = await Reveries.open(source.directory);
  await setup.recordNew({ path: "big.bin", revision: "HEAD", semantic: withSource, metadata });
  const directory = await cloneRepository(source.directory, "partial-hook", [
    "--filter=blob:none",
    "--no-local",
  ], { fetchNotesFilter: "blob:none", keepOrigin: true });
  const before = (await GitRepository.open(directory)).withoutLazyFetch();
  assert.ok(
    (await before.missingObjects([objectId(source.oldBlob)])).has(objectId(source.oldBlob)),
    "fixture requires the source blob to stay missing",
  );
  const result = await handleHookEvent({
    host: "test",
    event: "after-tool",
    session: "s1",
    tool: "read",
    input: { path: "big.bin" },
    output: {},
  }, { cwd: directory });
  assert.equal(result.reason, "incomplete-evidence");
  assert.equal(result.completeness, "promisor-object-missing");
  assert.equal(result.context, null);
  const after = (await GitRepository.open(directory)).withoutLazyFetch();
  assert.ok(
    (await after.missingObjects([objectId(source.oldBlob)])).has(objectId(source.oldBlob)),
    "automatic delivery must not lazily fetch the missing source blob",
  );
});

test("broken sources in complete clones still report broken-source", async () => {
  const source = await createSource();
  const setup = await Reveries.open(source.directory);
  const missing = "0123456789abcdef0123456789abcdef01234567";
  await setup.recordNew({
    path: "state.txt",
    revision: "HEAD",
    semantic: {
      ...semantic,
      sources: [{ relation: "derived-from" as const, kind: "blob" as const, ref: missing }],
    },
    metadata,
  }).then(
    () => { throw new Error("recording with a missing blob source must fail validation"); },
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /broken local blob source/i);
    },
  );
});

test("receive check fails closed when proposed objects are unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reveries-complete-bare-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "--bare", "-b", "main");
  const result = await checkReceive(directory, {
    updates: [{
      ref: "refs/heads/main",
      oldObject: null,
      newObject: objectId("0123456789abcdef0123456789abcdef01234567"),
    }],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => /unavailable/i.test(diagnostic)),
    `expected an unavailable-object diagnostic, got: ${result.diagnostics.join("; ")}`,
  );
});
