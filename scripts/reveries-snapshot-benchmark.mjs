// RVR-012 snapshot benchmark: memory + latency for 10,000 and 100,000 records.
//
// Run with: node --experimental-transform-types scripts/reveries-snapshot-benchmark.mjs [--sizes 10000,100000]
//
// Imports TypeScript sources directly so the numbers describe the worktree,
// not a stale dist build. Two layers:
//   protocol - in-process parse + validate + project + EvidenceSnapshot assembly.
//   git      - temp repository with 200 annotated blobs through listNotes,
//              the size-gated batch reader, and the full snapshot loader view.
// Prints a human table plus a JSON document on stdout (redirect to keep it).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { GitRepository } from "../packages/reveries/src/git.ts";
import { Reveries } from "../packages/reveries/src/operations.ts";
import {
  canonicalRecord,
  createEvidenceSnapshot,
  createReverie,
  objectId,
  parseNote,
  projectActiveReveries,
  validateNote,
} from "../packages/reveries/src/protocol.ts";

const execFileAsync = promisify(execFile);

function megabytes(bytes) {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function memory() {
  const usage = process.memoryUsage();
  return { rss: usage.rss, heapUsed: usage.heapUsed };
}

function hashFor(format) {
  return (bytes) => {
    const body = Buffer.from(bytes);
    const header = Buffer.from(`blob ${body.byteLength}\0`, "utf8");
    return objectId(createHash(format).update(header).update(body).digest("hex"));
  };
}

const hash = hashFor("sha1");

function makeRecord(index) {
  return createReverie(
    {
      v: 1,
      driving_event: `Benchmark corpus entry ${index} exposed repeated scan cost.`,
      decision: `Load snapshot shard ${index % 97} once because rescans cost more than an index.`,
      impact: `Validation pass ${index} shares one parse per note.`,
      recurrence_control: null,
      alternatives: [],
      sources: [],
      supersedes: [],
    },
    { author_email: "bench@example.com", session: null, created_at: "2026-08-25T03:00:00Z" },
    hash,
  );
}

async function benchmarkProtocol(total) {
  const perNote = 100;
  const bodies = [];
  for (let start = 0; start < total; start += perNote) {
    const lines = [];
    for (let index = start; index < Math.min(start + perNote, total); index += 1) {
      lines.push(canonicalRecord(makeRecord(index)).trimEnd());
    }
    bodies.push(`${lines.join("\n")}\n`);
  }
  const before = memory();
  const started = performance.now();
  let parsed = 0;
  const all = [];
  const byId = new Map();
  for (const body of bodies) {
    const tolerant = parseNote(body, "tolerant");
    const records = validateNote(tolerant.records);
    parsed += records.length;
    for (const record of records) {
      all.push(record);
      if (record.type === "reverie" && !byId.has(record.id)) byId.set(record.id, record);
    }
    projectActiveReveries(records.filter((record) => record.type === "reverie"));
  }
  const snapshot = createEvidenceSnapshot({
    notesTip: "0".repeat(40),
    records: all.filter((record) => record.type === "reverie").slice(0, 1024),
  });
  const elapsed = performance.now() - started;
  const after = memory();
  return {
    layer: "protocol",
    records: total,
    notes: bodies.length,
    parsed,
    byIdSize: byId.length ?? byId.size,
    snapshotRecords: snapshot.records.length,
    latencyMs: Math.round(elapsed),
    recordsPerSecond: Math.round((parsed / elapsed) * 1000),
    rssDelta: after.rss - before.rss,
    heapDelta: after.heapUsed - before.heapUsed,
    rssAfter: after.rss,
  };
}

async function git(cwd, ...args) {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function benchmarkGit(blobs = 200) {
  const directory = await mkdtemp(join(tmpdir(), "reveries-bench-"));
  try {
    await git(directory, "init", "-b", "main");
    await git(directory, "config", "user.name", "Reveries Bench");
    await git(directory, "config", "user.email", "bench@example.com");
    for (let index = 0; index < blobs; index += 1) {
      await writeFile(join(directory, `file-${index}.txt`), `content ${index}\n`, "utf8");
    }
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "initial");
    const repository = await GitRepository.open(directory);
    const format = await repository.objectFormat();
    const sha = hashFor(format);
    await repository.withNotesWrite(async (notes) => {
      for (let index = 0; index < blobs; index += 1) {
        const blob = await repository.resolvePath({ path: `file-${index}.txt`, revision: "HEAD" });
        const record = createReverie(
          {
            v: 1,
            driving_event: `Benchmark blob ${index} needed one batched read.`,
            decision: `Read blob ${index} through the batch reader because one process beats ${blobs} processes.`,
            impact: `Loader pass covers blob ${index}.`,
            recurrence_control: null,
            alternatives: [],
            sources: [],
            supersedes: [],
          },
          { author_email: "bench@example.com", session: null, created_at: "2026-08-25T03:00:00Z" },
          sha,
        );
        await notes.append(blob, canonicalRecord(record));
      }
    });
    const reveries = await Reveries.open(directory);
    const before = memory();
    const started = performance.now();
    const view = await reveries.loadEvidenceSnapshot();
    const elapsed = performance.now() - started;
    const after = memory();
    const cachedStarted = performance.now();
    const cached = await reveries.loadCachedEvidenceSnapshot();
    const cachedSecond = await reveries.loadCachedEvidenceSnapshot();
    const cachedElapsed = performance.now() - cachedStarted;
    return {
      layer: "git",
      blobs,
      notesParsed: view.stats.notesParsed,
      bytesRead: view.stats.bytesRead,
      loadLatencyMs: Math.round(elapsed),
      cachedTwoPassLatencyMs: Math.round(cachedElapsed),
      indexHit: cachedSecond.stats.indexHit,
      searchHits: (await reveries.cachedSearch({ query: "batch reader" })).length,
      rssDelta: after.rss - before.rss,
      heapDelta: after.heapUsed - before.heapUsed,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const sizes = (process.argv.find((arg) => arg.startsWith("--sizes="))?.slice("--sizes=".length) ?? "10000,100000")
  .split(",")
  .map(Number)
  .filter((value) => Number.isInteger(value) && value > 0);

const results = [];
for (const total of sizes) {
  results.push(await benchmarkProtocol(total));
}
results.push(await benchmarkGit());

for (const result of results) {
  if (result.layer === "protocol") {
    console.log(
      `protocol records=${result.records} notes=${result.notes} parsed=${result.parsed} ` +
      `latency=${result.latencyMs}ms throughput=${result.recordsPerSecond}/s ` +
      `rssΔ=${megabytes(result.rssDelta)} heapΔ=${megabytes(result.heapDelta)}`,
    );
  } else {
    console.log(
      `git blobs=${result.blobs} parsed=${result.notesParsed} bytes=${result.bytesRead} ` +
      `load=${result.loadLatencyMs}ms cached2x=${result.cachedTwoPassLatencyMs}ms ` +
      `indexHit=${result.indexHit} searchHits=${result.searchHits} ` +
      `rssΔ=${megabytes(result.rssDelta)} heapΔ=${megabytes(result.heapDelta)}`,
    );
  }
}
console.log(JSON.stringify({ results }, null, 2));
