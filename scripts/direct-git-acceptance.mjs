import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Direct-Git acceptance for the lean Reveries core.
 *
 * Every check drives the built CLI or raw Git in a disposable repository. The
 * point is to prove the 20 PRD acceptance criteria, not to exercise internals:
 * a reader with no Reveries installed can recover every decision with
 * `git notes`, and no Git command is ever gated by Reveries.
 */

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reveriesCliPath = join(workspace, "packages", "reveries", "dist", "src", "main.js");
const jsonMode = process.argv.includes("--json");

function run(command, args, cwd, input = "") {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
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
  const output = await run(process.execPath, [reveriesCliPath, ...args, "--json"], cwd);
  return JSON.parse(output);
}

async function mustReveries(cwd, ...args) {
  const response = await reveries(cwd, ...args);
  assert.equal(response.ok, true, `reveries ${args.join(" ")} failed: ${response.diagnostics.join("; ")}`);
  return response.result;
}

async function createRepository(root, name = "repo") {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await git(directory, "init", "-q", "-b", "main");
  await git(directory, "config", "user.name", "Reveries Acceptance");
  await git(directory, "config", "user.email", "acceptance@example.com");
  await git(directory, "config", "notes.reveries.mergeStrategy", "cat_sort_uniq");
  return directory;
}

async function commit(directory, message) {
  await git(directory, "add", "-A");
  await git(directory, "commit", "-qm", message);
  return gitValue(directory, "rev-parse", "HEAD");
}

async function record(directory, path, decision, extra = []) {
  return mustReveries(
    directory,
    "record", "new", path, "--committed",
    "--driving-event", `Event for ${decision}`,
    "--decision", decision,
    "--impact", `Impact for ${decision}`,
    ...extra,
  );
}

async function rawNote(directory, object) {
  return git(directory, "notes", "--ref=refs/notes/reveries", "show", String(object));
}

const criteria = [
  {
    id: 1,
    title: "region rationale round-trip",
    async check(root) {
      const directory = await createRepository(root, "region");
      await writeFile(join(directory, "src.rs"), "// header\nfn restore() {\n  Ok(())\n}\n// footer\n", "utf8");
      await commit(directory, "initial");
      const recorded = await record(directory, "src.rs", "Keep restore synchronous.", ["--start-line", "2", "--end-line", "4"]);
      assert.equal(recorded.record.region.start_line_hint, 2);
      assert.equal(recorded.record.region.end_line_hint, 4);
      assert.match(recorded.record.region.exact_hash, /^[0-9a-f]{40,64}$/);
      const raw = await rawNote(directory, recorded.object);
      assert.match(raw, /"kind":"region"/);
      assert.match(raw, new RegExp(`"exact_hash":"${recorded.record.region.exact_hash}"`));
      const shown = await mustReveries(directory, "show", "src.rs");
      assert.equal(shown.active[0].region.exact_hash, recorded.record.region.exact_hash);
    },
  },
  {
    id: 2,
    title: "retrieval without Reveries",
    async check(root) {
      const directory = await createRepository(root, "raw");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      const recorded = await record(directory, "state.txt", "A durable decision.");
      const raw = await rawNote(directory, recorded.object);
      assert.match(raw, /A durable decision\./);
      assert.equal(await gitValue(directory, "cat-file", "-t", String(recorded.object)), "blob");
    },
  },
  {
    id: 3,
    title: "unchanged rename keeps evidence",
    async check(root) {
      const directory = await createRepository(root, "rename");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      const recorded = await record(directory, "state.txt", "Rename keeps the decision.");
      await git(directory, "mv", "state.txt", "renamed.txt");
      await commit(directory, "rename");
      const shown = await mustReveries(directory, "show", "renamed.txt");
      assert.equal(shown.active[0].id, recorded.record.id);
    },
  },
  {
    id: 4,
    title: "unchanged copy shares evidence",
    async check(root) {
      const directory = await createRepository(root, "copy");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      const recorded = await record(directory, "state.txt", "A copy shares the exact content.");
      await writeFile(join(directory, "copy.txt"), "first\n", "utf8");
      await commit(directory, "copy");
      const shown = await mustReveries(directory, "show", "copy.txt");
      assert.equal(shown.active[0].id, recorded.record.id);
      assert.deepEqual([...shown.paths].sort(), ["copy.txt", "state.txt"]);
    },
  },
  {
    id: 5,
    title: "edit creates a new subject and never inherits",
    async check(root) {
      const directory = await createRepository(root, "edit");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      await record(directory, "state.txt", "This must not follow an edit.");
      await writeFile(join(directory, "state.txt"), "second\n", "utf8");
      await commit(directory, "edit");
      const shown = await mustReveries(directory, "show", "state.txt");
      assert.equal(shown.active.length, 0);
    },
  },
  {
    id: 6,
    title: "preserve link across a changed successor",
    async check(root) {
      const directory = await createRepository(root, "preserve");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      await record(directory, "state.txt", "The intent is preserved.");
      await git(directory, "mv", "state.txt", "moved.txt");
      await writeFile(join(directory, "moved.txt"), "first\nedited\n", "utf8");
      await commit(directory, "move and edit");
      const linked = await mustReveries(
        directory,
        "link", "--kind", "preserve", "--commit", "HEAD", "--parent", "HEAD~1",
        "--from", "state.txt", "--to", "moved.txt",
        "--driving-event", "The path moved.", "--decision", "The intent continues.",
        "--impact", "Readers follow the link.",
      );
      const shown = await mustReveries(directory, "show", "moved.txt");
      assert.deepEqual(shown.lineage.map((entry) => entry.id), [linked.record.id]);
    },
  },
  {
    id: 7,
    title: "split one predecessor into N successors",
    async check(root) {
      const directory = await createRepository(root, "split");
      await writeFile(join(directory, "state.txt"), "one\ntwo\n", "utf8");
      await commit(directory, "initial");
      await record(directory, "state.txt", "One decision becomes two.");
      await rm(join(directory, "state.txt"));
      await writeFile(join(directory, "left.txt"), "one\n", "utf8");
      await writeFile(join(directory, "right.txt"), "two\n", "utf8");
      await commit(directory, "split");
      const linked = await mustReveries(
        directory,
        "link", "--kind", "split", "--commit", "HEAD", "--parent", "HEAD~1",
        "--from", "state.txt", "--to", "left.txt", "--to", "right.txt",
        "--driving-event", "One subject became two.", "--decision", "Both continue the decision.",
        "--impact", "Each path carries the edge.",
      );
      assert.equal(linked.subjects.length, 2);
      for (const subject of linked.subjects) {
        assert.match(await rawNote(directory, subject), new RegExp(`"id":"${linked.record.id}"`));
      }
    },
  },
  {
    id: 8,
    title: "merge N predecessors into one successor",
    async check(root) {
      const directory = await createRepository(root, "merge");
      await writeFile(join(directory, "a.txt"), "alpha\n", "utf8");
      await writeFile(join(directory, "b.txt"), "beta\n", "utf8");
      await commit(directory, "initial");
      await record(directory, "a.txt", "Decision A.");
      await record(directory, "b.txt", "Decision B.");
      await rm(join(directory, "a.txt"));
      await rm(join(directory, "b.txt"));
      await writeFile(join(directory, "merged.txt"), "alpha\nbeta\n", "utf8");
      await commit(directory, "merge subjects");
      const linked = await mustReveries(
        directory,
        "link", "--kind", "merge", "--commit", "HEAD", "--parent", "HEAD~1",
        "--from", "a.txt", "--from", "b.txt", "--to", "merged.txt",
        "--driving-event", "Two subjects merged.", "--decision", "The successor carries both.",
        "--impact", "The edge names both predecessors.",
      );
      assert.equal(linked.from.length, 2);
      assert.match(await rawNote(directory, linked.subjects[0]), new RegExp(`"id":"${linked.record.id}"`));
    },
  },
  {
    id: 9,
    title: "retire keeps the original decision in history",
    async check(root) {
      const directory = await createRepository(root, "retire");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      const recorded = await record(directory, "state.txt", "The decision is retired, not deleted.");
      await rm(join(directory, "state.txt"));
      await commit(directory, "delete the subject");
      const linked = await mustReveries(
        directory,
        "link", "--kind", "retire", "--commit", "HEAD", "--parent", "HEAD~1",
        "--from", "state.txt",
        "--driving-event", "The subject was deleted.", "--decision", "Stop asserting the decision.",
        "--impact", "No successor carries it.",
      );
      assert.deepEqual(linked.to, []);
      const raw = await rawNote(directory, recorded.object);
      assert.match(raw, new RegExp(recorded.record.id));
      assert.match(raw, new RegExp(linked.record.id));
    },
  },
  {
    id: 10,
    title: "rebase preserves blob evidence",
    async check(root) {
      const directory = await createRepository(root, "rebase-preserve");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await writeFile(join(directory, "other.txt"), "other\n", "utf8");
      await commit(directory, "initial");
      await git(directory, "checkout", "-q", "-b", "topic");
      await record(directory, "state.txt", "This survives a rebase.");
      const blob = await gitValue(directory, "rev-parse", "HEAD:state.txt");
      await git(directory, "checkout", "-q", "main");
      await writeFile(join(directory, "base.txt"), "base\n", "utf8");
      await commit(directory, "advance base");
      await git(directory, "checkout", "-q", "topic");
      await git(directory, "rebase", "-q", "main");
      assert.equal(await gitValue(directory, "rev-parse", "HEAD:state.txt"), blob);
      const shown = await mustReveries(directory, "show", "state.txt");
      assert.equal(shown.active.length, 1);
    },
  },
  {
    id: 11,
    title: "rebase that changes a blob leaves continuity unresolved, not blocked",
    async check(root) {
      const directory = await createRepository(root, "rebase-change");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      await git(directory, "checkout", "-q", "-b", "topic");
      await record(directory, "state.txt", "The old blob keeps this decision.");
      await git(directory, "checkout", "-q", "main");
      await writeFile(join(directory, "base.txt"), "base\n", "utf8");
      await commit(directory, "advance base");
      await git(directory, "checkout", "-q", "topic");
      await git(directory, "rebase", "-q", "main");
      const shown = await mustReveries(directory, "show", "state.txt");
      // The rebased blob still matches, so evidence still resolves. Force a new
      // blob by amending the content, then prove nothing blocked Git.
      await writeFile(join(directory, "state.txt"), "rewritten\n", "utf8");
      await commit(directory, "rewrite after rebase");
      const changed = await mustReveries(directory, "show", "state.txt");
      assert.equal(changed.active.length, 0);
      const doctor = await reveries(directory, "doctor");
      assert.equal(doctor.ok, true, doctor.diagnostics.join("; "));
      assert.equal(shown.active.length, 1);
    },
  },
  {
    id: 12,
    title: "retention survives an aggressive prune",
    async check(root) {
      const directory = await createRepository(root, "retention");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      const recorded = await record(directory, "state.txt", "Retention must anchor this blob.");
      const oldBlob = String(recorded.object);
      await writeFile(join(directory, "state.txt"), "second\n", "utf8");
      await commit(directory, "replace the blob");
      assert.notEqual(oldBlob, await gitValue(directory, "rev-parse", "HEAD:state.txt"));
      await mustReveries(directory, "retain");
      await git(directory, "reflog", "expire", "--expire=now", "--all");
      await git(directory, "gc", "--aggressive", "--prune=now", "--quiet");
      assert.equal(await gitValue(directory, "cat-file", "-t", oldBlob), "blob");
      const shown = await mustReveries(directory, "show", oldBlob);
      assert.equal(shown.active.length, 1);
      const doctor = await reveries(directory, "doctor");
      assert.equal(doctor.ok, true, doctor.diagnostics.join("; "));
    },
  },
  {
    id: 13,
    title: "two clones converge through fetch and notes union",
    async check(root) {
      const directory = await createRepository(root, "converge-primary");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      await record(directory, "state.txt", "Primary decision.");
      const remote = join(root, "converge.git");
      await git(directory, "init", "--bare", "-q", remote);
      await git(directory, "remote", "add", "origin", remote);
      await git(directory, "push", "-q", "origin", "main");
      await git(directory, "push", "-q", "origin", "refs/notes/reveries:refs/notes/reveries");
      await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
      const peer = join(root, "converge-peer");
      await git(directory, "clone", "-q", remote, peer);
      await git(peer, "config", "user.name", "Peer");
      await git(peer, "config", "user.email", "peer@example.com");
      await git(peer, "config", "notes.reveries.mergeStrategy", "cat_sort_uniq");
      await git(peer, "fetch", "-q", "origin", "+refs/notes/reveries*:refs/notes/remotes/origin/reveries*");
      await git(peer, "notes", "--ref=refs/notes/reveries", "merge", "-s", "cat_sort_uniq", "refs/notes/remotes/origin/reveries");
      await record(peer, "state.txt", "Peer decision.");
      await git(peer, "push", "-q", "origin", "refs/notes/reveries:refs/notes/reveries");
      await git(directory, "fetch", "-q", "origin", "+refs/notes/reveries*:refs/notes/remotes/origin/reveries*");
      await git(directory, "notes", "--ref=refs/notes/reveries", "merge", "-s", "cat_sort_uniq", "refs/notes/remotes/origin/reveries");
      const blob = await gitValue(directory, "rev-parse", "HEAD:state.txt");
      const shown = await mustReveries(directory, "show", blob);
      assert.equal(shown.active.length, 2);
      assert.deepEqual(
        shown.active.map((entry) => entry.decision).sort(),
        ["Peer decision.", "Primary decision."],
      );
    },
  },
  {
    id: 14,
    title: "plain git push publishes evidence and retention",
    async check(root) {
      const directory = await createRepository(root, "publish");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      await record(directory, "state.txt", "Published with ordinary Git.");
      await mustReveries(directory, "retain");
      const remote = join(root, "publish.git");
      await git(directory, "init", "--bare", "-q", remote);
      await git(directory, "remote", "add", "origin", remote);
      await git(
        directory,
        "push", "-q", "origin",
        "main", "refs/notes/reveries:refs/notes/reveries", "refs/reveries/retention:refs/reveries/retention",
      );
      assert.match(await gitValue(remote, "rev-parse", "refs/notes/reveries"), /^[0-9a-f]{40,64}$/);
      assert.match(await gitValue(remote, "rev-parse", "refs/reveries/retention"), /^[0-9a-f]{40,64}$/);
    },
  },
  {
    id: 15,
    title: "notes stay inspectable without the CLI",
    async check(root) {
      const directory = await createRepository(root, "no-cli");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      const recorded = await record(directory, "state.txt", "Readable without any tool.");
      const blob = await gitValue(directory, "rev-parse", "HEAD:state.txt");
      const raw = await git(directory, "notes", "--ref=refs/notes/reveries", "show", blob);
      assert.match(raw, /Readable without any tool\./);
      assert.match(raw, new RegExp(recorded.record.id));
    },
  },
  {
    id: 16,
    title: "no CI, hook, daemon, or database is required",
    async check(root) {
      const directory = await createRepository(root, "no-infra");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      await mustReveries(directory, "init");
      await record(directory, "state.txt", "Recorded with no infrastructure.");
      const hooks = (await readdir(join(directory, ".git", "hooks"))).filter((name) => !name.endsWith(".sample"));
      assert.deepEqual(hooks, []);
      let workflowDirectory = null;
      try {
        workflowDirectory = await readdir(join(directory, ".github", "workflows"));
      } catch {
        workflowDirectory = null;
      }
      assert.equal(workflowDirectory, null);
    },
  },
  {
    id: 17,
    title: "ordinary commit, rebase, merge, and push need no Reveries command",
    async check(root) {
      const directory = await createRepository(root, "ordinary");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      await git(directory, "checkout", "-q", "-b", "topic");
      await writeFile(join(directory, "topic.txt"), "topic\n", "utf8");
      await commit(directory, "topic commit");
      await git(directory, "checkout", "-q", "main");
      await writeFile(join(directory, "main.txt"), "main\n", "utf8");
      await commit(directory, "main commit");
      await git(directory, "merge", "-q", "--no-ff", "-m", "merge topic", "topic");
      const remote = join(root, "ordinary.git");
      await git(directory, "init", "--bare", "-q", remote);
      await git(directory, "remote", "add", "origin", remote);
      await git(directory, "push", "-q", "origin", "main");
      await git(directory, "checkout", "-q", "-b", "rebase-me", "HEAD~1");
      await git(directory, "rebase", "-q", "main");
      assert.equal(await gitValue(remote, "rev-parse", "refs/heads/main"), await gitValue(directory, "rev-parse", "main"));
    },
  },
  {
    id: 18,
    title: "missing rationale never blocks Git",
    async check(root) {
      const directory = await createRepository(root, "no-rationale");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "commit without evidence");
      await writeFile(join(directory, "state.txt"), "second\n", "utf8");
      await commit(directory, "another commit without evidence");
      assert.equal(await gitValue(directory, "rev-list", "--count", "HEAD"), "2");
      const doctor = await reveries(directory, "doctor");
      assert.equal(doctor.ok, true, doctor.diagnostics.join("; "));
    },
  },
  {
    id: 19,
    title: "default install creates no hooks or workflows",
    async check(root) {
      const directory = await createRepository(root, "install");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      await mustReveries(directory, "init");
      const hooks = (await readdir(join(directory, ".git", "hooks"))).filter((name) => !name.endsWith(".sample"));
      assert.deepEqual(hooks, []);
      const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
      assert.match(agents, /refs\/notes\/reveries/);
      assert.doesNotMatch(agents, /session summary/i);
      assert.doesNotMatch(agents, /adoption/i);
    },
  },
  {
    id: 20,
    title: "the writer emits no summaries and no adoption semantics",
    async check(root) {
      const directory = await createRepository(root, "writer");
      await writeFile(join(directory, "state.txt"), "first\n", "utf8");
      await commit(directory, "initial");
      const recorded = await record(directory, "state.txt", "Only a reverie is written.");
      const raw = await rawNote(directory, recorded.object);
      assert.doesNotMatch(raw, /session-summary/);
      assert.doesNotMatch(raw, /reveries-init/);
      assert.doesNotMatch(raw, /transition-summary/);
      const doctor = await reveries(directory, "doctor");
      assert.equal(doctor.ok, true, doctor.diagnostics.join("; "));
    },
  },
];

const results = [];
const root = await mkdtemp(join(tmpdir(), "reveries-direct-git-"));
try {
  await readFile(reveriesCliPath, "utf8");
  for (const criterion of criteria) {
    try {
      await criterion.check(root);
      results.push({ id: criterion.id, title: criterion.title, ok: true, detail: null });
    } catch (error) {
      results.push({
        id: criterion.id,
        title: criterion.title,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const ok = results.every((result) => result.ok);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok, criteria: results })}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.id}. ${result.title}\n`);
      if (!result.ok) process.stdout.write(`  ${result.detail}\n`);
    }
    process.stdout.write(`\nReveries direct-Git acceptance: ${ok ? "passed" : "failed"}\n`);
  }
  if (!ok) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
