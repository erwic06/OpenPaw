PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    task_id TEXT,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    started_at TIMESTAMP NOT NULL,
    ended_at TIMESTAMP,
    terminal_state TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    error TEXT
);

CREATE TABLE IF NOT EXISTS hitl_gates (
    id TEXT PRIMARY KEY,
    gate_type TEXT NOT NULL,
    task_id TEXT,
    session_id TEXT REFERENCES sessions(id),
    requested_at TIMESTAMP NOT NULL,
    decided_at TIMESTAMP,
    decision TEXT,
    context_summary TEXT
);

CREATE TABLE IF NOT EXISTS cost_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id),
    service TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    logged_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_communications (
    id TEXT PRIMARY KEY,
    gate_id TEXT REFERENCES hitl_gates(id),
    agent_id TEXT,
    platform TEXT NOT NULL,
    recipient TEXT,
    content_type TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL,
    decided_at TIMESTAMP,
    decision TEXT,
    edited_content TEXT
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    repo_url TEXT,
    workspace_path TEXT,
    created_at TIMESTAMP NOT NULL
);

CREATE VIEW IF NOT EXISTS daily_spend_by_service AS
SELECT date(logged_at) AS day, service, SUM(amount_usd) AS total
FROM cost_log
GROUP BY day, service;

CREATE VIEW IF NOT EXISTS monthly_spend_by_agent AS
SELECT s.agent, SUM(c.amount_usd) AS total
FROM cost_log c
JOIN sessions s ON c.session_id = s.id
WHERE c.logged_at >= date('now', 'start of month')
GROUP BY s.agent;

CREATE VIEW IF NOT EXISTS most_expensive_sessions AS
SELECT s.id, s.agent, s.task_id, s.model, s.started_at, SUM(c.amount_usd) AS total_cost
FROM cost_log c
JOIN sessions s ON c.session_id = s.id
GROUP BY s.id
ORDER BY total_cost DESC;
