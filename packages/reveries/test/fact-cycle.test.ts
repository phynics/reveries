import assert from "node:assert/strict";
import { test } from "node:test";

import { factGraphDiagnostics, projectFactGraph } from "../src/projection.ts";
import { recordFactId } from "../src/protocol.ts";
import type { CorrectionRecord, NoteRecord, ResolutionRecord } from "../src/protocol.ts";

const CR_A = "cr:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CR_B = "cr:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RS_A = "rs:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function correction(id: string, supersedes: string[], decision: string): CorrectionRecord {
  return {
    v: 1,
    type: "correction",
    id: id as CorrectionRecord["id"],
    driving_event: "Two corrections named each other.",
    decision,
    impact: "The cycle must stay visible instead of converging silently.",
    recurrence_control: null,
    alternatives: [],
    sources: [],
    supersedes: supersedes as CorrectionRecord["supersedes"],
    author_email: "reveries@example.com",
    session: null,
    created_at: "2026-09-29T07:00:00Z",
  };
}

function resolution(id: string, resolves: string[]): ResolutionRecord {
  return {
    v: 1,
    type: "resolution",
    id: id as ResolutionRecord["id"],
    driving_event: "A resolution closed the loop.",
    decision: "Name every head so the cycle stays inspectable.",
    impact: "The cycle remains visible with its resolution attached.",
    recurrence_control: null,
    alternatives: [],
    sources: [],
    resolves: resolves as ResolutionRecord["resolves"],
    author_email: "reveries@example.com",
    session: null,
    created_at: "2026-09-29T07:00:00Z",
  };
}

test("a correction cycle stays visible instead of converging", () => {
  const left = correction(CR_A, [CR_B], "The left correction supersedes the right one.");
  const right = correction(CR_B, [CR_A], "The right correction supersedes the left one.");
  const graph = projectFactGraph([left, right] as NoteRecord[]);
  assert.equal(graph.cycles.length, 1);
  assert.ok(factGraphDiagnostics(graph).some((diagnostic) => /cycle/i.test(diagnostic)));
});

test("a correction that supersedes itself is a visible cycle", () => {
  const self = correction(CR_A, [CR_A], "The correction supersedes itself.");
  const graph = projectFactGraph([self] as NoteRecord[]);
  assert.equal(graph.cycles.length, 1);
});

test("a resolution attached to a cycle keeps the cycle inspectable", () => {
  const left = correction(CR_A, [CR_B], "The left correction supersedes the right one.");
  const right = correction(CR_B, [CR_A], "The right correction supersedes the left one.");
  const resolve = resolution(RS_A, [CR_A, CR_B]);
  const graph = projectFactGraph([left, right, resolve] as NoteRecord[]);
  assert.equal(graph.cycles.length, 1);
  assert.ok(graph.active.some((record) => recordFactId(record) === RS_A));
});
