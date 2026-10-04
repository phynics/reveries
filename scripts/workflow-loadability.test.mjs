import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const root = new URL("..", import.meta.url);

// Contexts that the runner provides only while a job runs. They are not
// available when GitHub loads a workflow, so a job-level `env:` that references
// one makes GitHub reject the entire file. GitHub does not report the bad
// expression: the workflow's name falls back to the raw path, no trigger
// registers, and the only symptom is a zero-job failure on every push. That is
// how `reveries-receive-check.yml` went offline without a usable error.
const runnerOnlyContexts = ["runner.", "job.", "steps.", "strategy.", "matrix.", "needs."];

// Contexts that are safe wherever a workflow is evaluated.
const loadTimeContexts = ["github.", "env.", "vars.", "secrets.", "inputs."];

const workflowDir = new URL(".github/workflows/", root);
const workflowFiles = (await readdir(workflowDir)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

const expressionsIn = (text) => [...text.matchAll(/\$\{\{([^}]*)\}\}/g)].map((match) => match[1]);
const namedContexts = (expression) => [...expression.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\./g)].map((match) => `${match[1]}.`);

for (const file of workflowFiles) {
  test(`${file} parses as a workflow GitHub will load`, async () => {
    const text = await readFile(new URL(file, workflowDir), "utf8");
    const workflow = parseYaml(text);

    // A workflow GitHub refuses to load loses its `name` and its triggers. Both
    // are cheap to assert, and both were wrong when this failed.
    assert.equal(typeof workflow.name, "string", `${file} must declare a top-level name`);
    assert.doesNotMatch(workflow.name, /\$\{\{/, `${file} name is load-time metadata`);
    assert.ok(workflow.on !== undefined, `${file} must declare triggers`);

    // `on` may parse as the boolean `true` under YAML 1.1 rules.
    const triggers = workflow.on ?? workflow[true];
    assert.ok(triggers === null || typeof triggers === "object" || typeof triggers === "string",
      `${file} triggers must be a mapping, a string, or null`);
  });

  test(`${file} keeps run-only contexts out of load-time fields`, async () => {
    const workflow = parseYaml(await readFile(new URL(file, workflowDir), "utf8"));

    // Workflow-level and job-level `env:` are evaluated when the run starts,
    // before any step exists, so `runner` and `steps` are unavailable there.
    const offenders = [];
    const check = (env, where) => {
      for (const [key, value] of Object.entries(env ?? {})) {
        if (typeof value !== "string") continue;
        for (const expression of expressionsIn(value)) {
          const used = namedContexts(expression).filter((context) => runnerOnlyContexts.includes(context));
          if (used.length > 0) offenders.push(`${where} env.${key} uses ${used.join(", ")}: ${expression.trim()}`);
        }
      }
    };

    check(workflow.env, "workflow");
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      check(job.env, `jobs.${jobId}`);
      // `if:` is evaluated by the runner for each job, but `runs-on` and the
      // job's `name` are read earlier; keep run-only contexts out of all of
      // them to stay on the safe side.
      for (const field of ["name", "runs-on"]) {
        const value = job[field];
        const values = Array.isArray(value) ? value : [value];
        for (const entry of values) {
          if (typeof entry !== "string") continue;
          for (const expression of expressionsIn(entry)) {
            const used = namedContexts(expression).filter((context) => runnerOnlyContexts.includes(context));
            if (used.length > 0) offenders.push(`jobs.${jobId}.${field} uses ${used.join(", ")}: ${expression.trim()}`);
          }
        }
      }
    }

    assert.deepEqual(offenders, [],
      `load-time fields must not reference run-only contexts; GitHub rejects the whole file without an error:\n${offenders.join("\n")}`);
  });
}

test("every load-time expression names a context that exists", async () => {
  // Cheap typo guard: an unknown context is also a hard load failure. Only the
  // leading identifier is a context; the rest is a property path, so
  // `github.event.pull_request.base` names the `github` context once.
  const known = [...loadTimeContexts, ...runnerOnlyContexts, "secrets."];
  const offenders = [];
  for (const file of workflowFiles) {
    const text = await readFile(new URL(file, workflowDir), "utf8");
    for (const expression of expressionsIn(text)) {
      const head = expression.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\./)?.[1];
      if (head !== undefined && !known.includes(`${head}.`)) {
        offenders.push(`${file}: unknown context ${head} in ${expression.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
