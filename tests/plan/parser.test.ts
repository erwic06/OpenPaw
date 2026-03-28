import { describe, it, expect, beforeAll, spyOn } from "bun:test";
import { parsePlan } from "../../src/plan/parser.ts";
import { getReadyTasks } from "../../src/plan/reader.ts";

const PLAN_PATH = import.meta.dir + "/../../implementation_plan.md";

let realContent: string;

beforeAll(async () => {
  realContent = await Bun.file(PLAN_PATH).text();
});

describe("parsePlan", () => {
  it("parses all tasks from the real plan", () => {
    const tasks = parsePlan(realContent);
    expect(tasks.length).toBe(18);
    expect(tasks.map((t) => t.id)).toEqual([
      "2.1", "2.2", "2.3", "2.4", "2.5", "2.6",
      "3.1", "3.2", "3.3", "3.4", "3.5", "3.6",
      "3.7", "3.8", "3.9", "3.10", "3.11", "3.12",
    ]);
  });

  it("populates all fields for task 2.1", () => {
    const tasks = parsePlan(realContent);
    const t = tasks.find((t) => t.id === "2.1")!;
    expect(t.title).toBe("NanoClaw Docker Container Setup");
    expect(t.status).toBe("complete");
    expect(t.type).toBe("infrastructure");
    expect(t.contract).toBe("contracts/2.1-nanoclaw-docker.md");
    expect(t.dependencies).toEqual([]);
    expect(t.assigned).toBe("interactive");
    expect(t.artifacts.length).toBeGreaterThan(0);
    expect(t.artifacts).toContain("Dockerfile");
    expect(t.acceptance).toBeTruthy();
  });

  it("parses dependencies correctly", () => {
    const tasks = parsePlan(realContent);
    const t22 = tasks.find((t) => t.id === "2.2")!;
    expect(t22.dependencies).toEqual(["2.1"]);

    const t25 = tasks.find((t) => t.id === "2.5")!;
    expect(t25.dependencies).toEqual(["2.2", "2.4"]);
  });

  it("parses 'Dependencies: none' as empty array", () => {
    const tasks = parsePlan(realContent);
    const t21 = tasks.find((t) => t.id === "2.1")!;
    expect(t21.dependencies).toEqual([]);
  });

  it("parses notes", () => {
    const tasks = parsePlan(realContent);
    const t21 = tasks.find((t) => t.id === "2.1")!;
    expect(t21.notes.length).toBeGreaterThan(0);
  });

  it("handles --- separators between tasks", () => {
    const content = `### 1.1 -- First Task
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

### 1.2 -- Second Task
- **Status:** ready
- **Type:** code
- **Contract:** contracts/1.2.md
- **Dependencies:** 1.1
- **Assigned:** interactive
- **Artifacts:** \`b.ts\`
- **Acceptance:** Also works

#### Notes
#### Failure History

---`;

    const tasks = parsePlan(content);
    expect(tasks.length).toBe(2);
    expect(tasks[0].id).toBe("1.1");
    expect(tasks[1].id).toBe("1.2");
  });

  it("warns on malformed entry but does not crash", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const content = `### 3.1 -- Incomplete Task
- **Type:** code

#### Notes
#### Failure History

---`;

    const tasks = parsePlan(content);
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe("unknown");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("getReadyTasks", () => {
  it("returns only ready tasks with all deps complete", () => {
    const tasks = parsePlan(realContent);
    const ready = getReadyTasks(tasks);
    for (const t of ready) {
      expect(t.status).toBe("ready");
    }
    // Phase 3 Tier 0 tasks (3.1, 3.2, 3.3) have no deps and are ready
    expect(ready.find((t) => t.id === "3.1")).toBeDefined();
    expect(ready.find((t) => t.id === "3.2")).toBeDefined();
    expect(ready.find((t) => t.id === "3.3")).toBeDefined();
    // 3.4 depends on 3.1 which is ready (not complete), so 3.4 should not be in ready
    expect(ready.find((t) => t.id === "3.4")).toBeUndefined();
    // blocked tasks should not appear
    expect(ready.find((t) => t.id === "3.6")).toBeUndefined();
  });

  it("excludes completed tasks", () => {
    const tasks = parsePlan(realContent);
    const ready = getReadyTasks(tasks);
    expect(ready.find((t) => t.id === "2.1")).toBeUndefined();
    expect(ready.find((t) => t.id === "2.2")).toBeUndefined();
  });

  it("handles tasks with no dependencies", () => {
    const content = `### 1.1 -- Solo Task
- **Status:** ready
- **Type:** code
- **Contract:** contracts/1.1.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** \`a.ts\`
- **Acceptance:** Works

#### Notes
#### Failure History

---`;

    const tasks = parsePlan(content);
    const ready = getReadyTasks(tasks);
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("1.1");
  });

  it("excludes ready tasks whose deps are not complete", () => {
    const content = `### 1.1 -- First
- **Status:** ready
- **Type:** code
- **Contract:** contracts/1.1.md
- **Dependencies:** none
- **Assigned:** interactive
- **Artifacts:** \`a.ts\`
- **Acceptance:** Works

#### Notes
#### Failure History

---

### 1.2 -- Second
- **Status:** ready
- **Type:** code
- **Contract:** contracts/1.2.md
- **Dependencies:** 1.1
- **Assigned:** interactive
- **Artifacts:** \`b.ts\`
- **Acceptance:** Works

#### Notes
#### Failure History

---`;

    const tasks = parsePlan(content);
    const ready = getReadyTasks(tasks);
    // 1.1 is ready with no deps, 1.2 is ready but 1.1 is not complete
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("1.1");
  });
});
