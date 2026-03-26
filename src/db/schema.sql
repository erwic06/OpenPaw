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
