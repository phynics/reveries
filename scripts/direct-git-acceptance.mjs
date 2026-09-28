import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cookbookPath = join(workspace, "skills", "using-reveries", "references", "direct-git.md");
const reveriesCliPath = join(workspace, "packages", "reveries", "dist", "src", "main.js");

function run(command, args, cwd, input = "") {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${errors}${output}`));
        return;
      }
      resolvePromise(output);
    });
    child.stdin.end(input, "utf8");
  });
}

async function git(cwd, ...args) {
  return run("git", args, cwd);
}

async function gitValue(cwd, ...args) {
  return (await git(cwd, ...args)).trim();
}

async function reveries(cwd, ...args) {
  const output = await run(
    process.execPath,
    [reveriesCliPath, ...args, "--json"],
    cwd,
  );
  return JSON.parse(output);
}

async function strictShow(cwd, object) {
  const response = await reveries(cwd, "show", object);
  assert.equal(response.ok, true, `reveries show rejected ${object}: ${response.diagnostics.join("; ")}`);
  assert.deepEqual(response.diagnostics, []);
  return response.result;
}

async function strictCheck(cwd, ...args) {
  const response = await reveries(cwd, "check", ...args);
  assert.equal(response.ok, true, `reveries check rejected ${args.join(" ")}: ${response.diagnostics.join("; ")}`);
  assert.deepEqual(response.diagnostics, []);
  return response.result;
}

async function makeReverie(cwd, {
  decision = "Use one guarded state boundary because it rejects conflicting transitions.",
  supersedes = [],
} = {}) {
  const semantic = {
    v: 1,
    driving_event: "A reproducible defect required one transition authority.",
    decision,
    impact: "All transition writers must use the guarded boundary.",
    recurrence_control: "A focused concurrency test rejects stale predecessors.",
    alternatives: [],
    sources: [],
    supersedes,
  };
  const semanticLine = `${JSON.stringify(semantic)}\n`;
  const oid = await run("git", ["hash-object", "--stdin"], cwd, semanticLine);
  const record = {
    v: 1,
    type: "reverie",
    id: `rv:${oid.trim()}`,
    ...semantic,
    author_email: "acceptance@example.com",
    session: null,
    created_at: "2026-08-25T03:00:00Z",
  };
  return { record, line: `${JSON.stringify(record)}\n` };
}

async function writeNote(cwd, object, lines, filePath, force = false) {
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  const args = ["notes", "--ref=refs/notes/reveries", "add"];
  if (force) args.push("--force");
  args.push("-F", filePath, object);
  await git(cwd, ...args);
}

async function checkCookbook(recipe) {
  const cookbook = await readFile(cookbookPath, "utf8");
  assert.doesNotMatch(cookbook, /--no-separator|--no-stripspace/, "cookbook contains Git 2.39-incompatible append flags");

  const recipes = {
    canonical: [
      "## Add a canonical record",
      "git notes --ref=refs/notes/reveries add -F",
      "git notes --ref=refs/notes/reveries add --force -F",
      '"$id" > /tmp/reverie-record.jsonl',
    ],
    continue: [
      "## Continue a reverie",
      "Copy its canonical line exactly",
      "git notes --ref=refs/notes/reveries add -F",
    ],
    supersede: [
      "## Supersede a reverie",
      "supersedes",
      "git notes --ref=refs/notes/reveries add -F",
    ],
    retire: [
      "## Retire a reverie and summarize the commit",
      "session-summary",
      "retirements",
    ],
    inspect: [
      "## Inspect reveries",
      "git notes --ref=refs/notes/reveries show",
      "git notes --ref=refs/notes/reveries list",
    ],
    sync: [
      "## Synchronize notes",
      "git fetch",
      "cat_sort_uniq",
    ],
    publish: [
      "## Publish changes",
      "refs/notes/reveries:refs/notes/reveries",
      "--no-verify",
      "lower-grade",
    ],
  };
  const selected = recipe === undefined ? Object.keys(recipes) : [recipe];
  for (const name of selected) {
    assert.ok(recipes[name], `unknown direct-Git acceptance recipe: ${name}`);
    for (const expected of recipes[name]) {
      assert.ok(cookbook.includes(expected), `${name} recipe is missing '${expected}'`);
    }
  }
  if (selected.includes("publish")) {
    const notesPush = cookbook.indexOf("git push --no-verify origin refs/notes/reveries:refs/notes/reveries");
    const branchPush = cookbook.indexOf('git push --no-verify origin "$branch:refs/heads/$branch"');
    assert.ok(notesPush >= 0 && branchPush > notesPush, "publish recipe must push notes before the code ref");
  }
}

const root = await mkdtemp(join(tmpdir(), "reveries-direct-git-"));
const directory = join(root, "primary");
try {
  await run("npm", ["run", "build", "--workspace", "@reveries/cli"], workspace);
  await mkdir(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Reveries acceptance");
  await git(directory, "config", "user.email", "acceptance@example.com");
  await writeFile(join(directory, "state.txt"), "one\n", "utf8");
  await git(directory, "add", "state.txt");
  await git(directory, "commit", "-m", "initial");

  const initialCommit = await gitValue(directory, "rev-parse", "HEAD");
  const originalBlob = await gitValue(directory, "rev-parse", "HEAD:state.txt");
  const original = await makeReverie(directory);
  await writeNote(directory, originalBlob, [original.line.trimEnd()], join(root, "original.jsonl"));
  assert.equal(
    await git(directory, "notes", "--ref=refs/notes/reveries", "show", originalBlob),
    original.line,
    "git notes add must preserve canonical record bytes and the final LF",
  );

  const second = await makeReverie(directory, {
    decision: "Keep transition validation at the shared state boundary.",
  });
  await writeNote(
    directory,
    originalBlob,
    [original.line.trimEnd(), second.line.trimEnd()],
    join(root, "combined.jsonl"),
    true,
  );
  assert.equal(
    await git(directory, "notes", "--ref=refs/notes/reveries", "show", originalBlob),
    `${original.line}${second.line}`,
    "git notes add --force must preserve multiple canonical JSONL records exactly",
  );

  const initialSummary = {
    v: 1,
    type: "session-summary",
    author_email: "acceptance@example.com",
    session: "acceptance:initialization",
    created_at: "2026-08-25T02:00:00Z",
    entries: [{
      driving_event: "The acceptance fixture records a starting engineering decision.",
      decision: "Initialize the fixture with the original transition boundary.",
      impact: "The fixture can validate strict Reveries continuity checks.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      reveries: [original.record.id],
      retirements: [],
    }],
  };
  const initialization = {
    v: 1,
    type: "reveries-init",
    protocol: 1,
    notes_ref: "refs/notes/reveries",
    publishing_remotes: [],
    hosts: [],
    author_email: "acceptance@example.com",
    created_at: "2026-08-25T02:00:00Z",
  };
  const initialSummaryLine = JSON.stringify(initialSummary);
  const initializationLine = JSON.stringify(initialization);
  await writeNote(
    directory,
    initialCommit,
    [initialSummaryLine, initializationLine],
    join(root, "initialization.jsonl"),
  );
  const initialCommitEvidence = await strictShow(directory, initialCommit);
  assert.deepEqual(initialCommitEvidence.records.map((record) => record.type), ["session-summary", "reveries-init"]);
  await strictCheck(directory, initialCommit);

  assert.deepEqual(
    (await strictShow(directory, originalBlob)).records.map((record) => record.id),
    [original.record.id, second.record.id],
    "strict CLI show must parse the canonical multi-record blob note",
  );

  await writeFile(join(directory, "state.txt"), "two\n", "utf8");
  await git(directory, "add", "state.txt");
  const successorBlob = await gitValue(directory, "rev-parse", ":state.txt");
  await writeNote(
    directory,
    successorBlob,
    [original.line.trimEnd(), second.line.trimEnd()],
    join(root, "continued.jsonl"),
  );
  assert.equal(
    await git(directory, "notes", "--ref=refs/notes/reveries", "show", successorBlob),
    `${original.line}${second.line}`,
    "continuation must copy all active canonical records unchanged",
  );
  const continuedEvidence = await strictShow(directory, successorBlob);
  assert.deepEqual(continuedEvidence.records.map((record) => record.id), [original.record.id, second.record.id]);
  await strictCheck(directory, "--staged");

  await git(directory, "commit", "-m", "continue decisions");
  const continuationCommit = await gitValue(directory, "rev-parse", "HEAD");
  const continuationSummary = {
    v: 1,
    type: "session-summary",
    author_email: "acceptance@example.com",
    session: "acceptance:continuation",
    created_at: "2026-08-25T03:30:00Z",
    entries: [{
      driving_event: "The original constraint still applies to the successor blob.",
      decision: "Continue the existing transition decisions unchanged.",
      impact: "Both canonical records remain active on the successor blob.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      reveries: [],
      retirements: [],
    }],
  };
  const continuationSummaryLine = `${JSON.stringify(continuationSummary)}\n`;
  await writeFile(join(root, "continuation-summary.jsonl"), continuationSummaryLine, "utf8");
  await git(
    directory,
    "notes",
    "--ref=refs/notes/reveries",
    "add",
    "-F",
    join(root, "continuation-summary.jsonl"),
    continuationCommit,
  );
  await strictCheck(directory, continuationCommit);

  await writeFile(join(directory, "state.txt"), "three\n", "utf8");
  await git(directory, "add", "state.txt");
  const supersedingBlob = await gitValue(directory, "rev-parse", ":state.txt");
  const superseding = await makeReverie(directory, {
    decision: "Use the revised transition boundary because the former constraint changed.",
    supersedes: [original.record.id],
  });
  await writeNote(directory, supersedingBlob, [superseding.line.trimEnd()], join(root, "superseding.jsonl"));
  const supersedingRead = JSON.parse(await git(directory, "notes", "--ref=refs/notes/reveries", "show", supersedingBlob));
  assert.deepEqual(supersedingRead.supersedes, [original.record.id]);
  assert.notEqual(supersedingRead.id, original.record.id);
  const supersedingEvidence = await strictShow(directory, supersedingBlob);
  assert.deepEqual(supersedingEvidence.records.map((record) => record.id), [superseding.record.id]);

  await git(directory, "commit", "-m", "supersede and retire decisions");
  const summaryCommit = await gitValue(directory, "rev-parse", "HEAD");
  const summary = {
    v: 1,
    type: "session-summary",
    author_email: "acceptance@example.com",
    session: "acceptance:retirement",
    created_at: "2026-08-25T04:00:00Z",
    entries: [{
      driving_event: "The earlier transition decision no longer applies to the final blob.",
      decision: "Retire the earlier decision while superseding the changed boundary.",
      impact: "The superseding decision replaces one record and retires the other.",
      recurrence_control: null,
      alternatives: [],
      sources: [],
      reveries: [superseding.record.id],
      retirements: [{
        reverie: second.record.id,
        from_blob: successorBlob,
        reason: "The earlier independent decision no longer applies after the transition boundary changed.",
      }],
    }],
  };
  const summaryLine = `${JSON.stringify(summary)}\n`;
  const summaryPath = join(root, "summary.jsonl");
  await writeFile(summaryPath, summaryLine, "utf8");
  await git(directory, "notes", "--ref=refs/notes/reveries", "add", "-F", summaryPath, summaryCommit);
  assert.equal(await git(directory, "notes", "--ref=refs/notes/reveries", "show", summaryCommit), summaryLine);
  const summaryEvidence = await strictShow(directory, summaryCommit);
  assert.equal(summaryEvidence.records.length, 1, "a commit must have exactly one causal session summary");
  const decodedSummary = summaryEvidence.records[0];
  assert.equal(decodedSummary.type, "session-summary");
  assert.equal(decodedSummary.entries[0].retirements[0].from_blob, successorBlob);
  await strictCheck(directory, summaryCommit);
  assert.match(await gitValue(directory, "log", "-1", "--format=%H", "refs/notes/reveries"), /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

  const listed = await git(directory, "notes", "--ref=refs/notes/reveries", "list", originalBlob);
  const noteContents = await git(directory, "notes", "--ref=refs/notes/reveries", "show", originalBlob);
  const expectedNote = await run("git", ["hash-object", "--stdin"], directory, noteContents);
  assert.equal(listed.trim(), expectedNote.trim());
  assert.match(await git(directory, "ls-files", "-s"), new RegExp(`${supersedingBlob}.*state\\.txt`));
  assert.equal(await gitValue(directory, "rev-parse", "HEAD:state.txt"), supersedingBlob);

  const remote = join(root, "remote.git");
  const peer = join(root, "peer");
  await git(directory, "init", "--bare", remote);
  await git(directory, "remote", "add", "origin", remote);
  await git(directory, "push", "origin", "main");
  await git(directory, "push", "origin", "refs/notes/reveries:refs/notes/reveries");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(directory, "clone", remote, peer);
  await git(peer, "config", "user.name", "Reveries peer");
  await git(peer, "config", "user.email", "peer@example.com");
  await git(peer, "fetch", "origin", "+refs/notes/reveries*:refs/notes/remotes/origin/reveries*");
  await git(peer, "notes", "--ref=refs/notes/reveries", "merge", "-s", "cat_sort_uniq", "refs/notes/remotes/origin/reveries");

  const peerRecord = await makeReverie(peer, {
    decision: "A peer clone records an independent decision for synchronization.",
  });
  const primaryRecords = (await git(peer, "notes", "--ref=refs/notes/reveries", "show", originalBlob))
    .trimEnd()
    .split("\n");
  await writeNote(peer, originalBlob, [...primaryRecords, peerRecord.line.trimEnd()], join(root, "peer-combined.jsonl"), true);
  await git(peer, "push", "origin", "refs/notes/reveries:refs/notes/reveries");

  const localRecord = await makeReverie(directory, {
    decision: "The primary clone records a separate decision before synchronization.",
  });
  await writeNote(
    directory,
    originalBlob,
    [original.line.trimEnd(), second.line.trimEnd(), localRecord.line.trimEnd()],
    join(root, "local-combined.jsonl"),
    true,
  );
  await git(directory, "fetch", "origin", "+refs/notes/reveries*:refs/notes/remotes/origin/reveries*");
  await git(directory, "notes", "--ref=refs/notes/reveries", "merge", "-s", "cat_sort_uniq", "refs/notes/remotes/origin/reveries");
  const mergedEvidence = await strictShow(directory, originalBlob);
  assert.deepEqual(
    mergedEvidence.records.map((record) => record.id).sort(),
    [original.record.id, second.record.id, peerRecord.record.id, localRecord.record.id].sort(),
    "strict CLI show must validate the complete cat_sort_uniq union without losing a canonical record",
  );

  await git(directory, "push", "origin", "refs/notes/reveries:refs/notes/reveries");
  await git(directory, "push", "--no-verify", "origin", "main");
  assert.equal(
    await gitValue(directory, "rev-parse", "refs/notes/reveries"),
    await gitValue(remote, "rev-parse", "refs/notes/reveries"),
  );
  assert.equal(await gitValue(directory, "rev-parse", "main"), await gitValue(remote, "rev-parse", "refs/heads/main"));

  const selectedRecipe = process.argv.find((argument) => argument.startsWith("--recipe="))?.slice("--recipe=".length);
  await checkCookbook(selectedRecipe);
  process.stdout.write("Reveries direct-Git cookbook acceptance passed.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
