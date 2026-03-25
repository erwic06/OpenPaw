# Task X.Y -- [Task Title]

## Objective

What this task must accomplish. One paragraph.

## Context

Why this task exists. What depends on it. What it depends on.

## Requirements

- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

## Interface Contract

**Inputs:** What this task consumes (files, APIs, data).

**Outputs:** What this task produces (files, exports, side effects).

**Side Effects:** External state changes (database writes, config changes, deployed services).

## Technical Approach

Suggested implementation strategy. Not binding -- the implementer may deviate if the acceptance criteria are still met.

## Dependencies (if adding packages)

Skip this section if the task does not add new packages.

For each new dependency:

| Package | Version | Purpose | Transitive deps | Weekly downloads | Last published |
|---------|---------|---------|-----------------|------------------|----------------|
| name    | x.y.z   | Why     | N               | N                | YYYY-MM-DD     |

Audit checklist:
- [ ] Publisher and repo verified on npm/registry
- [ ] `bun audit` shows no known vulnerabilities in package or transitive deps
- [ ] Version pinned exactly in package.json (no ^, ~, or *)
- [ ] Alternatives considered (list briefly)
- [ ] If >20 transitive dependencies, justification provided for why a lighter alternative isn't viable

## Files to Create/Modify

- `path/to/file1` -- description
- `path/to/file2` -- description

## Acceptance Criteria

- [ ] Criterion 1 (include specific test command if applicable)
- [ ] Criterion 2
- [ ] Criterion 3

## What NOT to Do

- Anti-pattern or scope creep to avoid
- Features explicitly excluded from this task

## Recovery Guidance

Advice for retry sessions if this task fails:
- Common failure modes and how to address them
- What to check first on a retry

## References

- Link to relevant docs, APIs, or research
- Reference to design document sections
