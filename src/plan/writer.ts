/**
 * Plan writer: updates task status in implementation_plan.md.
 * Uses simple line-by-line string replacement matching the existing plan format.
 */

export async function updateTaskStatus(
  planPath: string,
  taskId: string,
  newStatus: string,
  notes?: string,
): Promise<void> {
  const content = await Bun.file(planPath).text();
  const lines = content.split("\n");

  // Find task header: ### X.Y -- Title
  const escapedId = taskId.replace(/\./g, "\\.");
  const headerPattern = new RegExp(`^### ${escapedId} -- `);

  let taskStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerPattern.test(lines[i])) {
      taskStart = i;
      break;
    }
  }

  if (taskStart === -1) {
    throw new Error(`[plan-writer] task ${taskId} not found in plan`);
  }

  // Find end of task block (next task header or section header)
  let taskEnd = lines.length;
  for (let i = taskStart + 1; i < lines.length; i++) {
    if (/^### \d/.test(lines[i]) || /^## /.test(lines[i])) {
      taskEnd = i;
      break;
    }
  }

  // Find and update Status line
  let statusUpdated = false;
  for (let i = taskStart + 1; i < taskEnd; i++) {
    if (/^- \*\*Status:\*\*/.test(lines[i])) {
      lines[i] = `- **Status:** ${newStatus}`;
      statusUpdated = true;
      break;
    }
  }

  if (!statusUpdated) {
    throw new Error(`[plan-writer] status line not found for task ${taskId}`);
  }

  // Optionally add notes (insert before #### Failure History)
  if (notes) {
    for (let i = taskStart + 1; i < taskEnd; i++) {
      if (/^#### Failure History$/.test(lines[i].trim())) {
        lines.splice(i, 0, `- ${notes}`);
        break;
      }
    }
  }

  await Bun.write(planPath, lines.join("\n"));
}
