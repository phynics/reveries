import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import {
  GitRepository,
} from "../src/git.ts";
import { Reveries } from "../src/operations.ts";
import {
  blobId,
  canonicalRecord,
  createReverie,
  LimitExceededError,
  objectId,
  type ObjectId,
  type ReverieInput,
  type ReverieMetadata,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function createRepository(objectFormat: "sha1" | "sha256" = "sha1"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-snapshot-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main", `--object-format=${objectFormat}`);
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await writeFile(join(directory, "a.txt"), "alpha\n", "utf8");
  await writeFile(join(directory, "b.txt"), "beta\n", "utf8");
  await git(directory, "add", "a.txt", "b.txt");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

const semanticBase: ReverieInput = {
  v: 1,
  driving_event: "Repeated notes scans made validation cost quadratic.",
  decision: "Load one snapshot per evidence tip because shared indexes remove rescans.",
  impact: "Validation, search, and retention share one parse per note.",
  recurrence_control: "The snapshot test rejects a second parse of the same tip.",
  alternatives: [],
  sources: [],
  supersedes: [],
};

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: null,
  created_at: "2026-08-25T03:00:00Z",
};

function hashFor(format: "sha1" | "sha256") {
  return (bytes: Uint8Array) => {
    const body = Buffer.from(bytes);
    const header = Buffer.from(`blob ${body.byteLength}\0`, "utf8");
    return objectId(createHash(format).update(header).update(body).digest("hex"));
  };
}

async function annotateBlobs(directory: string, decisions: readonly string[]): Promise<ObjectId[]> {
  const repository = await GitRepository.open(directory);
  const format = await repository.objectFormat();
  const objects: ObjectId[] = [];
  await repository.withNotesWrite(async (notes) => {
    for (const decision of decisions) {
      const record = createReverie({ ...semanticBase, decision }, metadata, hashFor(format));
      const target = decision.includes("beta") ? "b.txt" : "a.txt";
      const blob = await repository.resolvePath({ path: target, revision: "HEAD" });
      await notes.append(blob, canonicalRecord(record));
      objects.push(blob);
    }
  });
  return objects;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("batchObjectSizes reports every size in one call and null for missing objects", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const blob = await repository.resolvePath({ path: "a.txt", revision: "HEAD" });
  const missing = blobId("f".repeat(40));

  const sizes = await repository.batchObjectSizes([blob, missing]);

  assert.equal(sizes.get(blob), Buffer.byteLength("alpha\n", "utf8"));
  assert.equal(sizes.get(missing), null);
});

test("readNotesBatch returns every body with one call and null for missing objects", async () => {
  const directory = await createRepository();
  await annotateBlobs(directory, [
    "Load one snapshot per evidence tip because shared indexes remove rescans.",
    "Load one snapshot per evidence tip because beta notes batch too.",
  ]);
  const repository = await GitRepository.open(directory);
  const first = await repository.resolvePath({ path: "a.txt", revision: "HEAD" });
  const second = await repository.resolvePath({ path: "b.txt", revision: "HEAD" });
  const entries = (await repository.listNotes()).filter(
    (entry) => entry.object === first || entry.object === second,
  );
  assert.equal(entries.length, 2);
  const missing = blobId("e".repeat(40));
  const bodies = await repository.readNotesBatch([
    ...entries,
    { note: missing, object: missing },
  ]);

  assert.ok((bodies.get(first) ?? "").includes("shared indexes remove rescans"));
  assert.ok((bodies.get(second) ?? "").includes("beta notes batch too"));
  assert.equal(bodies.get(missing), null);
});

test("readNotesBatch rejects an oversized note before loading any body", async () => {
  const directory = await createRepository();
  await annotateBlobs(directory, [
    "Load one snapshot per evidence tip because shared indexes remove rescans.",
  ]);
  const repository = await GitRepository.open(directory);
  const entries = await repository.listNotes();
  assert.equal(entries.length, 1);

  await assert.rejects(
    repository.readNotesBatch(entries, { limits: { maxNoteBytes: 10 } }),
    (error: unknown) => {
      assert.ok(error instanceof LimitExceededError);
      assert.equal(error.limit, "maxNoteBytes");
      return true;
    },
  );
});

test("hashBlobContent matches git hash-object for both object formats", async () => {
  for (const format of ["sha1", "sha256"] as const) {
    const directory = await createRepository(format);
    const repository = await GitRepository.open(directory);
    const { hashBlobContent } = await import("../src/git.ts");
    for (const content of ["{\"v\":1}\n", "alpha\n", "unicode \u00e9\u4e2d\u{1f600}\n"]) {
      assert.equal(hashBlobContent(content, format), await repository.hashObject(content));
    }
  }
});

test("loadEvidenceSnapshot parses each note exactly once per tip", async () => {
  const directory = await createRepository();
  await annotateBlobs(directory, [
    "Load one snapshot per evidence tip because shared indexes remove rescans.",
    "Load one snapshot per evidence tip because beta notes batch too.",
  ]);
  const reveries = await Reveries.open(directory);

  const view = await reveries.loadEvidenceSnapshot();

  assert.ok(view.tip !== null);
  assert.equal(view.entries.length, 2);
  assert.equal(view.stats.notesParsed, 2);
  assert.equal(view.stats.notesListed, 2);
  assert.ok(view.stats.bytesRead > 0);
  assert.equal(view.byId.size, 2);
  for (const entry of view.entries) {
    assert.equal(entry.records.length, 1);
    assert.equal(entry.projection.active.length, 1);
  }
});

test("source validation resolves note references from the snapshot ID map", async () => {
  const directory = await createRepository();
  const repository = await GitRepository.open(directory);
  const format = await repository.objectFormat();
  const first = createReverie({ ...semanticBase, decision: "First decision anchors the backlink." }, metadata, hashFor(format));
  const second = createReverie(
    {
      ...semanticBase,
      decision: "Second decision cites the first through the snapshot map.",
      sources: [{ relation: "corroborated-by", kind: "note", ref: first.id }],
    },
    metadata,
    hashFor(format),
  );
  const blobA = await repository.resolvePath({ path: "a.txt", revision: "HEAD" });
  const blobB = await repository.resolvePath({ path: "b.txt", revision: "HEAD" });
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blobA, canonicalRecord(first));
    await notes.append(blobB, canonicalRecord(second));
  });

  const reveries = await Reveries.open(directory);
  const view = await reveries.loadEvidenceSnapshot();
  assert.deepEqual(view.backlinks.get(first.id) ?? [], [blobB]);
  await reveries.validateNotesSnapshot(view);

  const forged = `rv:${"0".repeat(40)}`;
  const broken = createReverie(
    {
      ...semanticBase,
      decision: "Broken decision cites a reverie that exists nowhere.",
      sources: [{ relation: "corroborated-by", kind: "note", ref: forged as typeof first.id }],
    },
    metadata,
    hashFor(format),
  );
  await repository.withNotesWrite(async (notes) => {
    await notes.append(blobB, canonicalRecord(broken));
  });
  const next = await reveries.loadEvidenceSnapshot();
  await assert.rejects(reveries.validateNotesSnapshot(next), /Referenced reverie does not exist/);
});

test("cached search matches fresh search and deleting the index changes nothing", async () => {
  const directory = await createRepository();
  await annotateBlobs(directory, [
    "Load one snapshot per evidence tip because shared indexes remove rescans.",
  ]);
  const reveries = await Reveries.open(directory);

  const fresh = await reveries.search({ query: "snapshot" });
  const cached = await reveries.cachedSearch({ query: "snapshot" });
  assert.deepEqual(cached.map((hit) => hit.record), fresh.map((hit) => hit.record));

  const repository = await GitRepository.open(directory);
  const tip = await repository.notesTip();
  assert.ok(tip !== null);
  await repository.clearSnapshotIndex(tip!);
  const afterDelete = await reveries.cachedSearch({ query: "snapshot" });
  assert.deepEqual(afterDelete.map((hit) => hit.record), fresh.map((hit) => hit.record));
});

test("a corrupt index rebuilds without evidence loss", async () => {
  const directory = await createRepository();
  await annotateBlobs(directory, [
    "Load one snapshot per evidence tip because shared indexes remove rescans.",
  ]);
  const reveries = await Reveries.open(directory);
  const before = await reveries.cachedSearch({ query: "snapshot" });
  assert.equal(before.length, 1);

  const repository = await GitRepository.open(directory);
  const tip = await repository.notesTip();
  assert.ok(tip !== null);
  await repository.writeSnapshotIndex(tip!, "{corrupt!!!");
  assert.equal(await repository.readSnapshotIndex(tip!), "{corrupt!!!");

  const after = await reveries.cachedSearch({ query: "snapshot" });
  assert.deepEqual(after.map((hit) => hit.record), before.map((hit) => hit.record));
  const rebuilt = await repository.readSnapshotIndex(tip!);
  assert.ok(rebuilt !== null && rebuilt !== "{corrupt!!!");
  const parsed = JSON.parse(rebuilt!) as { tip: string };
  assert.equal(parsed.tip, tip);
});

test("snapshot index lives under the git common directory", async () => {
  const directory = await createRepository();
  await annotateBlobs(directory, [
    "Load one snapshot per evidence tip because shared indexes remove rescans.",
  ]);
  const repository = await GitRepository.open(directory);
  const tip = await repository.notesTip();
  assert.ok(tip !== null);
  const path = repository.snapshotIndexPath(tip!);
  assert.ok(path.startsWith(await repository.commonDirectory()));
  assert.ok(path.includes(tip!));
  await repository.writeSnapshotIndex(tip!, "{\"tip\":1}");
  assert.equal(await repository.readSnapshotIndex(tip!), "{\"tip\":1}");
  await repository.clearSnapshotIndex(tip!);
  assert.equal(await repository.readSnapshotIndex(tip!), null);
});
