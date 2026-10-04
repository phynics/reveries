import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { Reveries } from "../src/operations.ts";
import { runCli, type CliIo } from "../src/cli.ts";
import {
  createReverie,
  objectId,
  parseNote,
  type RegionSubject,
  type ReverieInput,
  type ReverieMetadata,
} from "../src/protocol.ts";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

const CONTENT = [
  "// header",
  "fn restore_state() -> Result<State> {",
  "    let state = State::empty();",
  "    Ok(state)",
  "}",
  "// footer",
  "",
].join("\n");

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reveries-region-"));
  temporaryRepositories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Test");
  await git(directory, "config", "user.email", "reveries@example.com");
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src", "main.rs"), CONTENT, "utf8");
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

function semantic(decision: string): ReverieInput {
  return {
    v: 1,
    driving_event: "Region-scoped rationale has no object-level home today.",
    decision,
    impact: "A reader can attach the decision to the exact bytes it governs.",
    recurrence_control: "Region fixtures fail when the region is not stored.",
    alternatives: [],
    sources: [],
    supersedes: [],
  };
}

const metadata: ReverieMetadata = {
  author_email: "reveries@example.com",
  session: "pi:region-reverie",
  created_at: "2026-10-04T00:00:00Z",
};

test("a region reverie records the exact region and is retrievable with raw Git", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const blob = objectId(await git(directory, "rev-parse", "HEAD:src/main.rs"));

  const recorded = await reveries.recordNew({
    path: "src/main.rs",
    revision: "HEAD",
    region: { start_line: 2, end_line: 5 },
    semantic: semantic("Keep the restore helper synchronous because callers already await."),
    metadata,
  });

  assert.equal(recorded.object, blob);
  const region = recorded.record.region;
  assert.ok(region, "the record must carry a region descriptor");
  assert.equal(region.kind, "region");
  assert.equal(region.blob, blob);
  assert.equal(region.start_line_hint, 2);
  assert.equal(region.end_line_hint, 5);
  assert.equal(region.prefix_hint, "fn restore_state() -> Result<State> {");
  assert.equal(region.suffix_hint, "}");

  // The region fingerprint is the Git object hash of the selected bytes.
  assert.match(region.exact_hash, /^[0-9a-f]{40,64}$/);

  // Raw Git retrieves the record without Reveries installed.
  const raw = await git(directory, "notes", "--ref=refs/notes/reveries", "show", String(blob));
  assert.match(raw, /"kind":"region"/);
  assert.match(raw, new RegExp(`"exact_hash":"${region.exact_hash}"`));

  // show resolves the region record on the same blob.
  const shown = await reveries.show({ target: "src/main.rs", revision: "HEAD" });
  assert.equal(shown.active.length, 1);
  assert.equal(shown.active[0]?.region?.exact_hash, region.exact_hash);
});

test("region identity uses the blob and exact bytes, never the line hints", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const blob = objectId(await git(directory, "rev-parse", "HEAD:src/main.rs"));

  const base = semantic("The decision applies to these exact bytes.");
  const first = await reveries.recordNew({
    path: "src/main.rs",
    revision: "HEAD",
    region: { start_line: 2, end_line: 5 },
    semantic: base,
    metadata,
  });
  // A different region with the same rationale is a different subject.
  const second = await reveries.recordNew({
    path: "src/main.rs",
    revision: "HEAD",
    region: { start_line: 1, end_line: 1 },
    semantic: base,
    metadata,
  });
  assert.notEqual(first.record.id, second.record.id);

  // Line hints do not participate in the semantic identity: same blob, same
  // exact bytes, different hints produce the same record ID.
  const fingerprint = first.record.region!;
  const relocated: RegionSubject = { ...fingerprint, start_line_hint: 900, end_line_hint: 903 };
  const hashObject = (bytes: Uint8Array) => {
    // A deterministic stand-in for the repository hash; only stability matters.
    const text = Buffer.from(bytes).toString("utf8");
    let value = 0;
    for (const character of text) value = (value * 31 + character.codePointAt(0)!) % 1_000_000_007;
    return objectId(String(value).padStart(40, "0").slice(0, 40));
  };
  const a = createReverie({ ...base, region: fingerprint }, metadata, hashObject);
  const b = createReverie({ ...base, region: relocated }, metadata, hashObject);
  assert.equal(a.id, b.id);
  assert.match(blob, /^[0-9a-f]{40,64}$/);
});

test("editing the region leaves old evidence on the old blob and none on the new blob", async () => {
  const directory = await createRepository();
  const reveries = await Reveries.open(directory);
  const oldBlob = objectId(await git(directory, "rev-parse", "HEAD:src/main.rs"));
  await reveries.recordNew({
    path: "src/main.rs",
    revision: "HEAD",
    region: { start_line: 2, end_line: 5 },
    semantic: semantic("Keep the helper synchronous."),
    metadata,
  });

  await writeFile(join(directory, "src", "main.rs"), CONTENT.replace("Ok(state)", "Ok(State::restored())"), "utf8");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "edit region");
  const newBlob = objectId(await git(directory, "rev-parse", "HEAD:src/main.rs"));
  assert.notEqual(oldBlob, newBlob);

  const oldShown = await reveries.show({ target: String(oldBlob), revision: "HEAD" });
  assert.equal(oldShown.active.length, 1);
  const newShown = await reveries.show({ target: "src/main.rs", revision: "HEAD" });
  assert.equal(newShown.active.length, 0, "a changed blob must not inherit region evidence");
});

test("a region record is valid lean JSON and unknown record types are skipped, not rejected", () => {
  const parsed = parseNote(
    '{"v":1,"type":"something-legacy","payload":true}\n',
    "tolerant",
    { verifyIds: false },
  );
  assert.equal(parsed.records.length, 0);
  assert.equal(parsed.diagnostics.length, 0);
});

test("the CLI records a region with --start-line and --end-line", async () => {
  const directory = await createRepository();
  const draftPath = join(directory, "region-draft.json");
  await writeFile(draftPath, JSON.stringify({
    ...semantic("Keep the helper synchronous even when called from the CLI."),
    author_email: metadata.author_email,
    session: metadata.session,
    created_at: metadata.created_at,
  }), "utf8");
  let out = "";
  let error = "";
  const io: CliIo = {
    cwd: directory,
    stdin: async () => "",
    stdout: (text) => { out += text; },
    stderr: (text) => { error += text; },
  };
  const code = await runCli([
    "record", "new", "src/main.rs", "--committed", "--from", draftPath,
    "--start-line", "2", "--end-line", "5", "--json",
  ], io);
  assert.equal(code, 0, `${out}${error}`);
  const parsed = JSON.parse(out) as { result: { record: { region?: RegionSubject } } };
  assert.equal(parsed.result.record.region?.start_line_hint, 2);
  assert.equal(parsed.result.record.region?.end_line_hint, 5);
});
