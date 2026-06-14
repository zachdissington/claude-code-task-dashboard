import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { config } from "../src/config.js";
import { deleteIfExists } from "./helpers.js";
import { readSessionBindings } from "../src/data/state-files.js";

/** The reader recovers a binding corrupted with unescaped Windows backslashes
 *  (the real-world one-off) and names a truly-garbage file in the error. */
describe("readSessionBindings — malformed-file handling", () => {
  const dir = join(config.TMP_DIR, "session_bindings");
  const malformed = join(dir, "SIM-TEST-malformed.json");
  const garbage = join(dir, "SIM-TEST-garbage.json");

  afterEach(() => {
    deleteIfExists(malformed);
    deleteIfExists(garbage);
  });

  it("recovers a single-backslash (unescaped Windows path) binding", async () => {
    // Note the SINGLE backslashes — invalid JSON, as the stray writer produced.
    writeFileSync(
      malformed,
      '{\n  "session_id": "SIM-TEST-malformed",\n  "task_id": "T-2099-12-31-001",\n' +
        '  "task_fs_path": "C:\\Dev\\workspace\\Internal\\task-dashboard\\tasks\\T-2099-12-31-001.md",\n' +
        '  "task_fs_id": "T-2099-12-31-001",\n  "task_title": "RECOVERED fixture",\n' +
        '  "bound_at": "2099-12-31T00:00:00-04:00"\n}\n',
      "utf-8",
    );
    const res = await readSessionBindings();
    const rec = res.data.find((b) => b.task_fs_id === "T-2099-12-31-001");
    expect(rec?.task_title).toBe("RECOVERED fixture");
    // recovered, so NOT counted among skipped:
    expect(res.error || "").not.toContain("SIM-TEST-malformed.json");
  });

  it("skips genuinely-garbage JSON and names the file in the error", async () => {
    writeFileSync(garbage, "this is not json at all {{{", "utf-8");
    const res = await readSessionBindings();
    expect(res.error || "").toContain("SIM-TEST-garbage.json");
  });
});
