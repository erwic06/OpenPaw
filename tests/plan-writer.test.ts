import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { updateTaskStatus } from "../src/plan/writer.ts";

const SAMPLE_PLAN = `# OpenPaw -- Implementation Plan

### 3.8 -- Session Monitoring
- **Status:** complete
- **Type:** code
- **Contract:** contracts/3.8-session-monitoring.md
- **Dependencies:** 3.5

#### Notes
- Existing note here
#### Failure History

---

### 3.9 -- Session Runner
- **Status:** ready
- **Type:** code
- **Contract:** contracts/3.9-session-runner.md
- **Dependencies:** 3.2, 3.6, 3.7, 3.8

#### Notes
#### Failure History

---

## Session Log

| Session | Date | Task | Status |
|---------|------|------|--------|
| 1       | 2026-03-25 | 2.1  | complete |
`;

let planPath: string;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "plan-writer-test-"));
  planPath = join(dir, "implementation_plan.md");
  writeFileSync(planPath, SAMPLE_PLAN);
});

describe("updateTaskStatus", () => {
  it("updates a task's status", async () => {
    await updateTaskStatus(planPath, "3.9", "in-progress");
    const content = readFileSync(planPath, "utf-8");
    expect(content).toContain("- **Status:** in-progress");
  });

  it("does not modify other tasks", async () => {
    await updateTaskStatus(planPath, "3.9", "in-progress");
    const content = readFileSync(planPath, "utf-8");
    // 3.8 should remain complete
    const lines = content.split("\n");
    const idx38 = lines.findIndex((l) => l.includes("### 3.8 -- Session Monitoring"));
    expect(lines[idx38 + 1]).toBe("- **Status:** complete");
  });

  it("throws if task not found", () => {
    expect(updateTaskStatus(planPath, "99.99", "complete")).rejects.toThrow(
      "task 99.99 not found",
    );
  });

  it("adds notes before Failure History", async () => {
    await updateTaskStatus(planPath, "3.9", "failed", "Something went wrong");
    const content = readFileSync(planPath, "utf-8");
    expect(content).toContain("- **Status:** failed");
    expect(content).toContain("- Something went wrong");

    // Note should appear before #### Failure History
    const lines = content.split("\n");
    const noteIdx = lines.findIndex((l) => l.includes("Something went wrong"));
    const failIdx = lines.findIndex(
      (l, i) =>
        i > lines.findIndex((l2) => l2.includes("### 3.9")) &&
        l.trim() === "#### Failure History",
    );
    expect(noteIdx).toBeLessThan(failIdx);
  });

  it("preserves existing notes when updating status", async () => {
    await updateTaskStatus(planPath, "3.8", "in-progress");
    const content = readFileSync(planPath, "utf-8");
    expect(content).toContain("- Existing note here");
    expect(content).toContain("- **Status:** in-progress");
  });

  it("preserves existing notes when adding new ones", async () => {
    await updateTaskStatus(planPath, "3.8", "complete", "New note");
    const content = readFileSync(planPath, "utf-8");
    expect(content).toContain("- Existing note here");
    expect(content).toContain("- New note");
  });

  it("preserves session log section", async () => {
    await updateTaskStatus(planPath, "3.9", "complete");
    const content = readFileSync(planPath, "utf-8");
    expect(content).toContain("## Session Log");
    expect(content).toContain("| 1       | 2026-03-25 | 2.1  | complete |");
  });

  it("can update status multiple times", async () => {
    await updateTaskStatus(planPath, "3.9", "in-progress");
    await updateTaskStatus(planPath, "3.9", "complete");
    const content = readFileSync(planPath, "utf-8");
    expect(content).toContain("- **Status:** complete");
    expect(content).not.toContain("- **Status:** in-progress");
  });
});
