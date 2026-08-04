/**
 * MVP-A 正規 workingDir
 *
 * MVP-Aでは対象Repositoryを単一（`/workspace/target`）に固定する
 * （2026-08-02 CEO確定）。Project/Task/DB schemaへrepository pathフィールドは
 * 追加しない。`TARGET_ROOT`環境変数はAPI/Workerで同一パスを指す保証が確認できて
 * いないため使用しない。
 *
 * `POST /api/jobs`（Job作成）と`resumeBlockedTask()`（Job再作成）の両方が
 * この定数を再利用し、クライアントからworkingDirを受け取らない。
 */
export const TARGET_WORKING_DIR = '/workspace/target'
