import type { Task } from "./types.ts";

const TASK_HEADER = /^### (\d+\.\d+) -- (.+)$/;
const STATUS = /^- \*\*Status:\*\* ([\w-]+)/;
const TYPE = /^- \*\*Type:\*\* (.+)/;
const CONTRACT = /^- \*\*Contract:\*\* (.+)/;
const DEPENDENCIES = /^- \*\*Dependencies:\*\* (.+)/;
const ASSIGNED = /^- \*\*Assigned:\*\* (.+)/;
const ARTIFACTS = /^- \*\*Artifacts:\*\* (.+)/;
const ACCEPTANCE = /^- \*\*Acceptance:\*\* (.+)/;
const DEPLOY = /^- \*\*Deploy:\*\* (production|staging)/;
const NOTES_HEADER = /^#### Notes$/;
const FAILURE_HEADER = /^#### Failure History$/;
const TASK_SEPARATOR = /^---$/;

function parseArtifacts(raw: string): string[] {
  return raw
    .split(",")
    .map((a) => a.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

function parseDependencies(raw: string): string[] {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "none" || trimmed === "") return [];
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

export function parsePlan(content: string): Task[] {
  const lines = content.split("\n");
  const tasks: Task[] = [];
  let current: Partial<Task> | null = null;
  let inNotes = false;
  let inFailure = false;

  for (const line of lines) {
    const headerMatch = line.match(TASK_HEADER);
    if (headerMatch) {
      if (current && current.id) {
        tasks.push(finalizeTask(current));
      }
      current = {
        id: headerMatch[1],
        title: headerMatch[2].trim(),
        notes: [],
      };
      inNotes = false;
      inFailure = false;
      continue;
    }

    if (!current) continue;

    if (TASK_SEPARATOR.test(line.trim())) {
      if (current.id) {
        tasks.push(finalizeTask(current));
        current = null;
        inNotes = false;
        inFailure = false;
      }
      continue;
    }

    if (NOTES_HEADER.test(line.trim())) {
      inNotes = true;
      inFailure = false;
      continue;
    }

    if (FAILURE_HEADER.test(line.trim())) {
      inNotes = false;
      inFailure = true;
      continue;
    }

    if (inNotes && !inFailure) {
      const trimmed = line.trim();
      if (trimmed && trimmed.startsWith("- ") && !STATUS.test(trimmed)) {
        current.notes = current.notes || [];
        current.notes.push(trimmed.slice(2));
      }
      continue;
    }

    const statusMatch = line.match(STATUS);
    if (statusMatch) {
      current.status = statusMatch[1];
      continue;
    }

    const typeMatch = line.match(TYPE);
    if (typeMatch) {
      current.type = typeMatch[1].trim();
      continue;
    }

    const contractMatch = line.match(CONTRACT);
    if (contractMatch) {
      current.contract = contractMatch[1].trim();
      continue;
    }

    const depsMatch = line.match(DEPENDENCIES);
    if (depsMatch) {
      current.dependencies = parseDependencies(depsMatch[1]);
      continue;
    }

    const assignedMatch = line.match(ASSIGNED);
    if (assignedMatch) {
      current.assigned = assignedMatch[1].trim();
      continue;
    }

    const artifactsMatch = line.match(ARTIFACTS);
    if (artifactsMatch) {
      current.artifacts = parseArtifacts(artifactsMatch[1]);
      continue;
    }

    const acceptanceMatch = line.match(ACCEPTANCE);
    if (acceptanceMatch) {
      current.acceptance = acceptanceMatch[1].trim();
      continue;
    }

    const deployMatch = line.match(DEPLOY);
    if (deployMatch) {
      current.deploy = deployMatch[1] as "production" | "staging";
      continue;
    }
  }

  if (current && current.id) {
    tasks.push(finalizeTask(current));
  }

  return tasks;
}

function finalizeTask(partial: Partial<Task>): Task {
  const task: Task = {
    id: partial.id ?? "",
    title: partial.title ?? "",
    status: partial.status ?? "unknown",
    type: partial.type ?? "unknown",
    contract: partial.contract ?? "",
    dependencies: partial.dependencies ?? [],
    assigned: partial.assigned ?? "",
    artifacts: partial.artifacts ?? [],
    acceptance: partial.acceptance ?? "",
    notes: partial.notes ?? [],
    deploy: partial.deploy,
  };

  if (!task.id || !task.title) {
    console.warn(`[plan-reader] malformed task entry: missing id or title`);
  }
  if (!task.status || task.status === "unknown") {
    console.warn(`[plan-reader] task ${task.id}: missing status field`);
  }

  return task;
}
