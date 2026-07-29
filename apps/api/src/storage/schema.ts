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
    roadmap_task_key TEXT,
    phase INTEGER,
    roadmap_active INTEGER NOT NULL DEFAULT 0 CHECK (roadmap_active IN (0,1)),
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
    ai_cli_provider TEXT,
    ai_cli_prompt TEXT,
    ai_cli_mode TEXT,
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

  CREATE TABLE IF NOT EXISTS permission_grants (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    job_id TEXT,
    allowed_command_kinds TEXT NOT NULL DEFAULT '[]',
    agent_role TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at TEXT,
    reason TEXT,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    target_commit TEXT NOT NULL,
    target_diff_hash TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    requested_action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'WAITING_FOR_USER',
    expires_at TEXT NOT NULL,
    invalid_if TEXT NOT NULL DEFAULT '[]',
    changed_files TEXT NOT NULL DEFAULT '[]',
    triggered_rules TEXT NOT NULL DEFAULT '[]',
    reason TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS watchdog_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    command_kind TEXT NOT NULL,
    working_dir TEXT NOT NULL,
    started_at TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    stall_duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'detected',
    ai_analysis TEXT,
    is_stuck INTEGER,
    resolved_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_graph_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    phase TEXT,
    status TEXT NOT NULL DEFAULT 'inbox',
    risk TEXT NOT NULL DEFAULT 'LOW',
    priority TEXT NOT NULL DEFAULT 'medium',
    summary TEXT,
    related_docs TEXT NOT NULL DEFAULT '[]',
    related_files TEXT NOT NULL DEFAULT '[]',
    depends_on TEXT NOT NULL DEFAULT '[]',
    blocks TEXT NOT NULL DEFAULT '[]',
    related_features TEXT NOT NULL DEFAULT '[]',
    related_incidents TEXT NOT NULL DEFAULT '[]',
    related_decisions TEXT NOT NULL DEFAULT '[]',
    history_refs TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_graph_edges (
    id TEXT PRIMARY KEY,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (from_node_id) REFERENCES knowledge_graph_nodes(id),
    FOREIGN KEY (to_node_id) REFERENCES knowledge_graph_nodes(id)
  );

  CREATE TABLE IF NOT EXISTS decision_records (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]',
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    context TEXT NOT NULL DEFAULT '[]',
    related_node_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS incident_records (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    prevention TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    related_node_ids TEXT NOT NULL DEFAULT '[]',
    task_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pattern_records (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    feature_type TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL DEFAULT 'manual',
    related_node_ids TEXT NOT NULL DEFAULT '[]',
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS feature_dna (
    node_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT '',
    source_task_id TEXT,
    related_task_ids TEXT NOT NULL DEFAULT '[]',
    ai_notes TEXT NOT NULL DEFAULT '[]',
    history TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS self_reflections (
    id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL,
    summary TEXT NOT NULL,
    root_cause TEXT,
    improvement TEXT NOT NULL DEFAULT '',
    task_id TEXT,
    related_node_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
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
  { table: 'tasks', column: 'roadmap_task_key', definition: 'TEXT' },
  { table: 'tasks', column: 'phase', definition: 'INTEGER' },
  { table: 'tasks', column: 'roadmap_active', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'jobs', column: 'agent_role', definition: "TEXT NOT NULL DEFAULT 'developer_ai'" },
  { table: 'jobs', column: 'safe_command', definition: 'TEXT' },
  { table: 'jobs', column: 'dry_run', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'jobs', column: 'guard_result', definition: 'TEXT' },
  { table: 'jobs', column: 'approval_id', definition: 'TEXT' },
  { table: 'jobs', column: 'stdout_path', definition: 'TEXT' },
  { table: 'jobs', column: 'stderr_path', definition: 'TEXT' },
  { table: 'jobs', column: 'ai_cli_provider', definition: 'TEXT' },
  { table: 'jobs', column: 'ai_cli_prompt', definition: 'TEXT' },
  { table: 'jobs', column: 'ai_cli_mode', definition: 'TEXT' },
  { table: 'approval_requests', column: 'changed_files', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'approval_requests', column: 'triggered_rules', definition: "TEXT NOT NULL DEFAULT '[]'" },
]

/**
 * runMigrations() の後に実行するインデックス定義。
 * CREATE_TABLES に書くと、既存DBではまだ列が存在せず失敗するため分離している。
 */
export const INDEX_STATEMENTS: string[] = [
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_project_roadmap_task_key ON tasks(project_id, roadmap_task_key)',
]
