# OpenPaw -- Execution Lifecycle

Every Claude Code session in this repo follows this six-phase lifecycle. No exceptions.

## Phase 1: ORIENT

1. Read `project_spec.md` to understand the project.
2. Read `implementation_plan.md` to understand current state.
3. Read the session log at the bottom of `implementation_plan.md` to understand recent history.
4. **Do not start working yet.**

## Phase 2: SELECT

1. Find tasks with `Status: ready` whose dependencies are all `complete`.
2. Priority order:
   - Unblocked tasks (all dependencies `complete`)
   - Previously `failed` tasks (retry)
   - Lowest-numbered group first
   - Lowest task number within group
3. Read the task's contract file (listed in the task's `Contract` field).
4. Announce the selected task: task ID, title, and one-line summary of what the contract requires.

## Phase 3: EXECUTE

1. Set the task's status to `in-progress` in `implementation_plan.md`.
2. Do the work described in the contract.
3. **Hard stop conditions** -- if any of these occur, set the task to `blocked`, explain in the Notes section, and go directly to TERMINATE:
   - `project_spec.md` needs modification (requires human approval).
   - The contract is wrong or contradictory.
   - The task is impossible given current project state.
   - A dependency that was marked `complete` is actually broken.

## Phase 4: VERIFY

1. Run all acceptance criteria from the contract. Check each one explicitly.
2. If tests exist, run them. Fix failing tests.
3. If acceptance criteria cannot be met after reasonable effort, set the task to `failed` with an explanation in Failure History. Go to UPDATE.
4. Run the full test suite (if one exists) to check for regressions.

## Phase 5: UPDATE

1. Set the task's final status in `implementation_plan.md`:
   - `complete` -- all gates passed
   - `failed` -- acceptance criteria not met (add Failure History entry)
   - `blocked` -- hard stop condition hit (explain in Notes)
2. Check if completing this task unblocks others: update any task whose dependencies are now all `complete` from `blocked` to `ready`.
3. Commit all changes to git with a descriptive message referencing the task ID.
4. Append a session log entry to the table at the bottom of `implementation_plan.md`.

## Phase 6: TERMINATE

1. Brief summary: what was done, what the outcome was.
2. If `failed` or `blocked`: explain what the next session needs to know.
3. Stop.

---

## Completion Gates

ALL of these must be true before marking a task `complete`:

- [ ] All acceptance criteria from the contract are satisfied
- [ ] All tests pass (task-specific and full suite)
- [ ] `implementation_plan.md` is updated with final status
- [ ] All changes are committed to git
- [ ] Session log entry is appended

## Hard Rules

- **Never** mark a task `complete` with failing tests.
- **Never** modify `project_spec.md` without human approval. If it needs changes, set the current task to `blocked` and terminate.
- **Never** work on a task whose dependencies are not all `complete`.
- **Never** skip ORIENT.
- **One task per session** unless the task is trivially small and the human approves continuing.
