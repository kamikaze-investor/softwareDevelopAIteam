/**
 * SQLite Schema定義
 *
 * better-sqlite3 で使用するテーブル定義
 */

export const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    goal TEXT NOT NULL,
    design_philosophy TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    assignee TEXT NOT NULL DEFAULT 'cto_ai',
    provider TEXT,
    dependencies TEXT NOT NULL DEFAULT '[]',
    allowed_paths TEXT NOT NULL DEFAULT '[]',
    forbidden_paths TEXT NOT NULL DEFAULT '[]',
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    expected_outputs TEXT NOT NULL DEFAULT '[]',
    branch_name TEXT,
    commit_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    agent_role TEXT NOT NULL DEFAULT 'developer_ai',
    status TEXT NOT NULL DEFAULT 'queued',
    safe_command TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    exit_code INTEGER,
    stdout TEXT,
    stderr TEXT,
    stdout_path TEXT,
    stderr_path TEXT,
    changed_files TEXT NOT NULL DEFAULT '[]',
    commit_hash TEXT,
    rollback_info TEXT,
    guard_result TEXT,
    approval_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TEXT,
    review_note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS review_results (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    findings TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS qa_results (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    details TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );
`

/**
 * Existing databases need explicit ALTER TABLE statements because
 * CREATE TABLE IF NOT EXISTS does not change already-created tables.
 */
export const MIGRATION_STATEMENTS: Array<{ table: string; column: string; definition: string }> = [
  { table: 'tasks', column: 'provider', definition: 'TEXT' },
  { table: 'tasks', column: 'allowed_paths', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'tasks', column: 'forbidden_paths', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'tasks', column: 'acceptance_criteria', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'tasks', column: 'expected_outputs', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'jobs', column: 'agent_role', definition: "TEXT NOT NULL DEFAULT 'developer_ai'" },
  { table: 'jobs', column: 'safe_command', definition: 'TEXT' },
  { table: 'jobs', column: 'dry_run', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'jobs', column: 'guard_result', definition: 'TEXT' },
  { table: 'jobs', column: 'approval_id', definition: 'TEXT' },
  { table: 'jobs', column: 'stdout_path', definition: 'TEXT' },
  { table: 'jobs', column: 'stderr_path', definition: 'TEXT' },
]
