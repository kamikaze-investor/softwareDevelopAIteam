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

  CREATE TABLE IF NOT EXISTS project_roadmap_phases (
    project_id TEXT NOT NULL,
    phase_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    goal TEXT NOT NULL,
    roadmap_active INTEGER NOT NULL DEFAULT 1 CHECK (roadmap_active IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, phase_number),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    workflow_step_key TEXT,
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
    failure_metadata TEXT,
    failure_explanation_json TEXT,
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

  CREATE TABLE IF NOT EXISTS design_review_evidence (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    design_text_hash TEXT NOT NULL,
    review_load TEXT NOT NULL,
    decision TEXT NOT NULL,
    independent_review_required INTEGER NOT NULL DEFAULT 0,
    independent_review_verdict TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS gate_evaluations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    job_id TEXT,
    target_branch TEXT NOT NULL,
    target_commit TEXT NOT NULL,
    target_diff_hash TEXT NOT NULL,
    decision TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    triggered_rules TEXT NOT NULL DEFAULT '[]',
    policy_version TEXT NOT NULL,
    binding_verification TEXT NOT NULL DEFAULT 'unverified',
    approved_content_hash TEXT,
    resulting_commit TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS design_review_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    design_text TEXT NOT NULL,
    design_text_hash TEXT NOT NULL,
    task_title TEXT NOT NULL DEFAULT '',
    changed_files TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
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

  CREATE TABLE IF NOT EXISTS outbox_applied_events (
    event_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );

  CREATE TABLE IF NOT EXISTS task_continuations (
    id TEXT PRIMARY KEY,
    source_job_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    completed_task_id TEXT NOT NULL,
    next_task_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (source_job_id) REFERENCES jobs(id),
    FOREIGN KEY (completed_task_id) REFERENCES tasks(id),
    FOREIGN KEY (next_task_id) REFERENCES tasks(id),
    UNIQUE (source_job_id),
    UNIQUE (completed_task_id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    operation TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    result TEXT NOT NULL,
    detail TEXT,
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
  { table: 'gate_evaluations', column: 'binding_verification', definition: "TEXT NOT NULL DEFAULT 'unverified'" },
  { table: 'gate_evaluations', column: 'approved_content_hash', definition: 'TEXT' },
  { table: 'gate_evaluations', column: 'resulting_commit', definition: 'TEXT' },
  { table: 'design_review_runs', column: 'task_title', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'design_review_runs', column: 'changed_files', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'jobs', column: 'agent_role', definition: "TEXT NOT NULL DEFAULT 'developer_ai'" },
  { table: 'jobs', column: 'workflow_step_key', definition: 'TEXT' },
  { table: 'jobs', column: 'safe_command', definition: 'TEXT' },
  { table: 'jobs', column: 'dry_run', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'jobs', column: 'guard_result', definition: 'TEXT' },
  { table: 'jobs', column: 'failure_metadata', definition: 'TEXT' },
  { table: 'jobs', column: 'failure_explanation_json', definition: 'TEXT' },
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
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_single_running ON projects(status) WHERE status = 'running'",
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_approval_id ON jobs(approval_id) WHERE approval_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_workflow_step_key ON jobs(workflow_step_key) WHERE workflow_step_key IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_review_results_job_id ON review_results(job_id)',
  'CREATE INDEX IF NOT EXISTS ix_design_review_evidence_task_created_at ON design_review_evidence(task_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS ix_audit_log_entity ON audit_log(entity_type, entity_id, created_at DESC)',
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_design_review_runs_task_active ON design_review_runs(task_id) WHERE status IN ('queued','running')",
  'CREATE INDEX IF NOT EXISTS ix_gate_evaluations_task_created_at ON gate_evaluations(task_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS ix_gate_evaluations_target ON gate_evaluations(target_commit, target_diff_hash)',
  // 1 ALLOW = 1 git_commit = 1 resulting_commit。
  // 同一commitへ複数のtrusted evidenceが曖昧にbindされないよう一意にする（NULLは対象外）。
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_gate_evaluations_resulting_commit ON gate_evaluations(resulting_commit) WHERE resulting_commit IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS ix_design_review_runs_status_started_at ON design_review_runs(status, started_at)',
  'CREATE INDEX IF NOT EXISTS ix_task_continuations_project ON task_continuations(project_id)',
  'CREATE INDEX IF NOT EXISTS ix_task_continuations_completed ON task_continuations(completed_task_id)',
]
