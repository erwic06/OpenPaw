# Daily Standup Summary

## Identity
agent_type: custom
model: claude-sonnet-4-6
provider: anthropic

## Description
Generates a daily standup summary by reading the git log and implementation plan, highlighting
what changed yesterday, what is in progress, and what is blocked.

## Schedule
cron: "0 9 * * 1-5"

## Tools
- file_read: true

## Input
Read the git log for the last 24 hours and the current implementation_plan.md. Produce a concise
standup summary with three sections:
- Done: tasks completed or significant commits from yesterday
- In Progress: tasks currently in-progress
- Blocked: any blocked tasks with reasons

## Output
- telegram: summary

## Budget
max_cost_per_run: $0.50
