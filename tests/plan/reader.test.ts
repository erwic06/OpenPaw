import { describe, it, expect, afterEach } from "bun:test";
import { watchPlan } from "../../src/plan/reader.ts";
import { mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("watchPlan", () => {
  let stopFn: (() => void) | null = null;
  let tmpDir: string;

  afterEach(() => {
    stopFn?.();
    stopFn = null;
  });

  it("detects file changes and emits newly-ready tasks", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "plan-reader-test-"));
    const planPath = join(tmpDir, "implementation_plan.md");

    // Write initial content with no ready tasks
    const initial = `### 1.1 -- Task One
- **Status:** complete
- **Type:** code
- **Contract:** contracts/1.1.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** \`a.ts\`
- **Acceptance:** Works

#### Notes
#### Failure History

---

### 1.2 -- Task Two
- **Status:** in-progress
- **Type:** code
- **Contract:** contracts/1.2.md
- **Dependencies:** 1.1
- **Assigned:** interactive
- **Artifacts:** \`b.ts\`
- **Acceptance:** Works

#### Notes
#### Failure History

---`;

    await writeFile(planPath, initial);

    let resolveReady: (tasks: any[]) => void;
    const readyPromise = new Promise<any[]>((resolve) => {
      resolveReady = resolve;
    });

    // Start watching — initial check finds no newly ready tasks
    // (1.1 is complete, 1.2 is in-progress)
    let callCount = 0;
    const { stop } = watchPlan(planPath, (tasks) => {
      callCount++;
      if (callCount === 1) {
        // This is from the file change, not initial check
        resolveReady(tasks);
      }
    });
    stopFn = stop;

    // Wait a bit for initial check to finish
    await new Promise((r) => setTimeout(r, 200));

    // Modify file to make task 1.2 ready
    const updated = initial.replace(
      "- **Status:** in-progress\n- **Type:** code\n- **Contract:** contracts/1.2.md",
      "- **Status:** ready\n- **Type:** code\n- **Contract:** contracts/1.2.md",
    );
    await writeFile(planPath, updated);

    const ready = await Promise.race([
      readyPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout waiting for file change")), 5000),
      ),
    ]);

    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("1.2");
    expect(ready[0].status).toBe("ready");
  });
});
