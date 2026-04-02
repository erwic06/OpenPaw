# TBPN Newsletter Digest

## Identity
agent_type: custom
model: gemini-3.1-pro
provider: google

## Description
Reads the daily TBPN newsletter and produces a concise digest highlighting the most relevant items
for an AI/ML engineer focused on agentic systems and developer tools.

## Schedule
cron: "0 20 * * *"

## Tools
- browseruse:
    mode: cloud
    headless: true
- web_search: true

## Input
Navigate to the TBPN newsletter archive and read today's edition. If no new edition today, report
"No new edition" and terminate.

Focus on:
- Agentic systems and agent frameworks
- Developer tools and IDE integrations
- LLM API changes and new model releases
- Infrastructure and deployment tooling

## Output
- telegram: summary
- github: full_report (path: research/tbpn/)

## Depth
level: 4

## Budget
max_cost_per_run: $1.00
