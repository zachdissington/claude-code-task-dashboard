import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { config } from "../src/config.js";
import { backupReviewState, deleteIfExists } from "./helpers.js";
import { readReviewState } from "../src/data/review-reader.js";

/**
 * review-reader is read-only and points at a single fixed path
 * (.tmp/review-state.json). Each test backs up + restores the real file so a
 * genuine evening-review stamp is never clobbered.
 */
describe("readReviewState", () => {
  const path = config.REVIEW_STATE_PATH;
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) restore();
    restore = null;
  });

  it("returns nulls and no error when the file is absent (never reviewed)", async () => {
    restore = backupReviewState();
    deleteIfExists(path);
    const res = await readReviewState();
    expect(res.lastReviewedDate).toBeNull();
    expect(res.lastReviewedAt).toBeNull();
    expect(res.error).toBeUndefined();
  });

  it("parses a well-formed stamp", async () => {
    restore = backupReviewState();
    writeFileSync(
      path,
      JSON.stringify({ lastReviewedDate: "2026-06-05", lastReviewedAt: "2026-06-05T22:14:03Z" }),
      "utf-8",
    );
    const res = await readReviewState();
    expect(res.lastReviewedDate).toBe("2026-06-05");
    expect(res.lastReviewedAt).toBe("2026-06-05T22:14:03Z");
    expect(res.error).toBeUndefined();
  });

  it("surfaces an error (not a throw) on garbage JSON", async () => {
    restore = backupReviewState();
    writeFileSync(path, "this is not json {{{", "utf-8");
    const res = await readReviewState();
    expect(res.lastReviewedDate).toBeNull();
    expect(res.error || "").toContain("review-state.json");
  });
});
