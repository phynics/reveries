import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorityId,
  originStreamRef,
  ORIGIN_REF_PREFIX,
  REMOTE_ROLES,
  resolveAuthorityRoles,
  rolePromotion,
  rolePublishable,
  roleSyncSource,
  type RemoteRole,
} from "../src/protocol.ts";

/**
 * RVR-017 makes the source of authoritative publication explicit. The role
 * vocabulary and its resolution are pure so the "exactly one primary" rule is
 * testable without a repository, and so a contradictory configuration is a
 * value the doctor can report rather than a shape it has to rediscover.
 *
 * Nothing here changes a ledger manifest. `manifest.authority` stays the primary
 * remote name, so the bytes RVR-009 signs are untouched.
 */

test("the role vocabulary is exactly primary, mirror, archive, and import-only", () => {
  assert.deepEqual([...REMOTE_ROLES], ["primary", "mirror", "archive", "import-only"]);
});

test("only the primary is promoted into canonical state", () => {
  assert.equal(rolePromotion("primary"), "promote");
  // A mirror carries evidence the primary already has, so merging it is not
  // required; an import is foreign evidence, and an archive is a destination.
  // All three are validated and kept, but none becomes canonical.
  assert.equal(rolePromotion("mirror"), "quarantine");
  assert.equal(rolePromotion("import-only"), "quarantine");
  assert.equal(rolePromotion("archive"), "quarantine");
});

test("an import-only remote is never a publication destination", () => {
  // A mirror and an archive are replicas this repository pushes *to*, so they
  // accept publication even though neither is merged back. An import-only remote
  // is someone else's history, and publishing into it would forge provenance.
  assert.equal(rolePublishable("primary"), true);
  assert.equal(rolePublishable("mirror"), true);
  assert.equal(rolePublishable("archive"), true);
  assert.equal(rolePublishable("import-only"), false);
});

test("an archive is not a synchronization source", () => {
  // An archive keeps evidence; it is not a place evidence is expected to come
  // from, so a sync from one has nothing legitimate to do.
  assert.equal(roleSyncSource("primary"), true);
  assert.equal(roleSyncSource("mirror"), true);
  assert.equal(roleSyncSource("import-only"), true);
  assert.equal(roleSyncSource("archive"), false);
});

test("a repository with no publishing remote has no authority to report", () => {
  const resolution = resolveAuthorityRoles([], {});
  assert.equal(resolution.state, "absent");
  assert.equal(resolution.primary, null);
  assert.deepEqual(resolution.diagnostics, []);
  assert.equal(resolution.roles.size, 0);
});

test("a single publishing remote with no declared role is an inferred primary", () => {
  const resolution = resolveAuthorityRoles(["origin"], {});
  assert.equal(resolution.state, "inferred");
  assert.equal(resolution.primary, "origin");
  // Inference is ordinary, so it carries no diagnostic. A repository that has
  // exactly one publisher has an unambiguous source without configuring one.
  assert.deepEqual(resolution.diagnostics, []);
});

test("several publishing remotes with no declared role are unconfigured, not damaged", () => {
  const resolution = resolveAuthorityRoles(["alpha", "beta"], {});
  assert.equal(resolution.state, "unconfigured");
  assert.equal(resolution.primary, null);
  // Absent authority is a notice: the repository may still be a healthy V1 setup
  // that never adopted roles. Only a contradictory configuration is damage.
  assert.deepEqual(resolution.diagnostics, []);
  assert.match(resolution.notice, /alpha/);
  assert.match(resolution.notice, /beta/);
});

test("one declared primary among several remotes is configured and authoritative", () => {
  const resolution = resolveAuthorityRoles(
    ["alpha", "beta", "vendor"],
    { alpha: "primary", beta: "mirror", vendor: "import-only" },
  );
  assert.equal(resolution.state, "configured");
  assert.equal(resolution.primary, "alpha");
  assert.deepEqual(resolution.diagnostics, []);
  assert.equal(resolution.roles.get("beta"), "mirror");
  assert.equal(resolution.roles.get("vendor"), "import-only");
});

test("a declared primary that is not a publishing remote is invalid", () => {
  const resolution = resolveAuthorityRoles(["alpha"], { beta: "primary" }, ["alpha", "beta"]);
  assert.equal(resolution.state, "invalid");
  assert.equal(resolution.primary, null);
  assert.match(resolution.diagnostics.join(" "), /beta/);
  assert.match(resolution.diagnostics.join(" "), /publishing/i);
});

test("two declared primaries are invalid and name both remotes", () => {
  const resolution = resolveAuthorityRoles(
    ["alpha", "beta"],
    { alpha: "primary", beta: "primary" },
  );
  assert.equal(resolution.state, "invalid");
  assert.equal(resolution.primary, null);
  const message = resolution.diagnostics.join(" ");
  // The diagnostic has to name both offenders, or an operator cannot tell which
  // one to demote without re-reading the whole configuration.
  assert.match(message, /alpha/);
  assert.match(message, /beta/);
  assert.match(message, /exactly one primary/i);
});

test("an unknown role is refused with the valid set named", () => {
  assert.throws(
    () => resolveAuthorityRoles(["alpha"], { alpha: "leader" as RemoteRole }),
    /reveries\.remoteRole/,
  );
  assert.throws(
    () => resolveAuthorityRoles(["alpha"], { alpha: "leader" as RemoteRole }),
    /primary, mirror, archive, import-only/,
  );
});

test("a role declared for a remote that does not exist is invalid", () => {
  const resolution = resolveAuthorityRoles(["alpha"], { ghost: "mirror" }, ["alpha"]);
  assert.equal(resolution.state, "invalid");
  assert.match(resolution.diagnostics.join(" "), /ghost/);
});

test("a role for a mirror remote that is not publishing is still valid", () => {
  // A mirror, archive, or import-only remote is by definition not a publisher,
  // so it must not be required to appear in `publishing_remotes`.
  const resolution = resolveAuthorityRoles(
    ["alpha"],
    { alpha: "primary", backup: "mirror", vault: "archive" },
    ["alpha", "backup", "vault"],
  );
  assert.equal(resolution.state, "configured");
  assert.equal(resolution.primary, "alpha");
  assert.equal(resolution.roles.get("backup"), "mirror");
  assert.equal(resolution.roles.get("vault"), "archive");
});

test("an origin stream ref is the prefix plus a validated authority id", () => {
  assert.equal(originStreamRef("north"), `${ORIGIN_REF_PREFIX}north`);
  assert.equal(ORIGIN_REF_PREFIX, "refs/heads/reveries-origin/");
});

test("an authority id is one path segment with no ref-unsafe characters", () => {
  assert.equal(authorityId("north"), "north");
  // A ref name cannot contain these, and an authority id becomes a ref segment,
  // so a name that Git would rewrite must be refused at the protocol layer.
  for (const unsafe of ["a/b", "a..b", "a~b", "a^b", "a?b", "a*b", "a[b", "a@{b", ".", "..", "a b"]) {
    assert.throws(() => authorityId(unsafe), /authority id/, `expected ${unsafe} to be refused`);
  }
  assert.throws(() => authorityId(""), /authority id/);
  assert.throws(() => authorityId("a\0b"), /authority id/);
  assert.throws(() => authorityId("a\nb"), /authority id/);
  // Trailing `.lock` is a ref-unsafe suffix Git itself rejects.
  assert.throws(() => authorityId("north.lock"), /authority id/);
});

test("an origin ref is recognized only for its own prefix", () => {
  // This is the guard that keeps an origin stream evidence rather than code: a
  // branch that merely starts with `reveries-` must not inherit the exemption.
  assert.equal(originStreamRef("north").startsWith(ORIGIN_REF_PREFIX), true);
});
