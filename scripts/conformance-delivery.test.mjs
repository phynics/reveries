import assert from "node:assert/strict";
import { test } from "node:test";
import { DELIVERY_CRITERIA, DELIVERY_GRADE_BLOCKERS, deliveryReport } from "./conformance-delivery.mjs";

test("AUTOMATIC DELIVERY covers every host with routing evidence and the 20-case suite", () => {
  const ids = DELIVERY_CRITERIA.map((item) => item.id);
  for (const host of ["pi", "claude-code", "opencode", "codex", "gemini-cli"]) {
    assert.ok(ids.includes(`adapter-suite-20-case-${host}`), `delivery criteria miss ${host}`);
  }
  assert.ok(ids.includes("skill-routing-evidence-fresh"));
});

test("recorded Pi routing evidence does not imply verified delivery", () => {
  const report = deliveryReport(
    Object.fromEntries(
      DELIVERY_CRITERIA.map((item) => [
        item.id,
        item.id === "skill-routing-evidence-fresh"
          ? { status: "passed", detail: "Pi 0.84.1 digests fresh" }
          : { status: "not-claimed", detail: "suite has not passed" },
      ]),
    ),
  );
  assert.equal(report.grade, "AUTOMATIC_DELIVERY");
  assert.equal(report.verdict, "not-claimed");
  assert.ok(DELIVERY_GRADE_BLOCKERS.length > 0);
});
