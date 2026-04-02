# PR Review on Main

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Description
Automatically reviews new commits on the main branch, checking for code quality issues,
potential bugs, and adherence to project conventions.

## Schedule
on_commit: main

## Tools
- file_read: true
- shell: true

## Input
Review the latest commit(s) on main. For each commit, check:
- Code quality and readability
- Potential bugs or edge cases
- Test coverage for changed code
- Adherence to project conventions (from CLAUDE.md)

Produce a review report with findings categorized as: critical, warning, info.

## Output
- github: full_report (path: reviews/)

## Budget
max_cost_per_run: $2.00
