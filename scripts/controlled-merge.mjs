const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const number = process.env.REVERIES_PULL_REQUEST;
const requiredCheck = process.env.REVERIES_REQUIRED_CHECK;
const requiredSlug = process.env.REVERIES_REQUIRED_APP_SLUG;
const requiredAppId = process.env.REVERIES_REQUIRED_APP_ID;
const expectedBaseTree = process.env.REVERIES_BASE_TREE;
const mergeMethod = process.env.REVERIES_MERGE_METHOD;

if (!repository || !token || !number || !requiredCheck || !requiredSlug || !requiredAppId || !expectedBaseTree) {
  throw new Error("The controlled merge bot requires repository, token, PR, check, app, and base-tree settings");
}
if (!/^\d+$/.test(requiredAppId)) throw new Error("REVERIES_REQUIRED_APP_ID must be the installed App's numeric ID");
if (!/^(merge|squash|rebase)$/.test(mergeMethod ?? "")) throw new Error("Unsupported merge method");

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const pullRequest = await github(`/repos/${repository}/pulls/${number}`);
const tree = await github(`/repos/${repository}/git/commits/${pullRequest.base.sha}`);
if (tree.sha !== expectedBaseTree && tree.tree?.sha !== expectedBaseTree) {
  throw new Error("The pull request base tree changed; the earlier receive-check is invalid");
}
const checks = await github(`/repos/${repository}/commits/${pullRequest.head.sha}/check-runs?check_name=${encodeURIComponent(requiredCheck)}`);
const passed = checks.check_runs?.some((run) => run.name === requiredCheck
  && run.conclusion === "success"
  && run.app?.slug === requiredSlug
  && String(run.app?.id) === requiredAppId);
if (!passed) throw new Error(`No successful ${requiredCheck} check from the installed ${requiredSlug} App`);

const merged = await github(`/repos/${repository}/pulls/${number}/merge`, {
  method: "PUT",
  body: JSON.stringify({ merge_method: mergeMethod }),
  headers: { "content-type": "application/json" },
});
if (merged.merged !== true) throw new Error(`GitHub did not merge the pull request: ${merged.message ?? "unknown reason"}`);
process.stdout.write(`Merged pull request #${number} after the app-owned receive-check.\n`);
