/**
 * Pure-function cron expression evaluator.
 * Supports standard 5-field format: minute hour day-of-month month day-of-week.
 */

export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length}`);
  }

  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = fields;
  return (
    matchField(minExpr, date.getMinutes(), 0, 59) &&
    matchField(hourExpr, date.getHours(), 0, 23) &&
    matchField(domExpr, date.getDate(), 1, 31) &&
    matchField(monExpr, date.getMonth() + 1, 1, 12) &&
    matchField(dowExpr, date.getDay(), 0, 6)
  );
}

export function nextCronTime(expression: string, after: Date): Date {
  // Start from the next minute
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Iterate minute-by-minute, max ~527040 iterations (1 year)
  const maxIterations = 527040;
  for (let i = 0; i < maxIterations; i++) {
    if (matchesCron(expression, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`No matching time found within 1 year for: ${expression}`);
}

function matchField(expr: string, value: number, min: number, max: number): boolean {
  if (expr === "*") return true;

  // Handle comma-separated list: "1,3,5"
  const parts = expr.split(",");
  return parts.some((part) => matchPart(part, value, min, max));
}

function matchPart(part: string, value: number, min: number, max: number): boolean {
  // Step: "*/5" or "1-10/2"
  const stepMatch = part.match(/^(.+)\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[2], 10);
    const base = stepMatch[1];

    if (base === "*") {
      return (value - min) % step === 0;
    }

    // Range with step: "1-10/2"
    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (value < start || value > end) return false;
      return (value - start) % step === 0;
    }

    return false;
  }

  // Range: "1-5"
  const rangeMatch = part.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    return value >= start && value <= end;
  }

  // Exact value: "5"
  return parseInt(part, 10) === value;
}
