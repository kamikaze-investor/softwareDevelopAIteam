# AITeamOS 開発効率最適化 — Sub-Phase 進捗

本流 Approval Gate Phase とは別の割り込みサブフェーズ。
完了後は Approval Gate gateProcessor.ts 統合へ戻る。

## 全体方針

- Knowledge Graph First: 索引 → Context Engine → Context Pack → AI実行
- Lazy Loading: Risk Level に応じて実行機能を切り替える
- 本文は持たず軽量メタデータのみ shared に置く

## Sub-Phase 一覧

| Phase | 内容 | 状態 |
|-------|------|------|
| SP-1 | Project Knowledge Graph — 型定義・Storage・API | ✅ done (`512c6ca`) |
| SP-2 | Project Timeline Map — CEO向け表示 | ✅ done (`17655de`) |
| SP-3 | Context Engine 接続 — Task→Graph参照・Context Pack生成 | ✅ done (`a5b283d`) |
| SP-4 | Impact Analyzer — changedFiles から影響Feature抽出 | ✅ done (`75e6519`) |
| SP-5 | Decision Cache / Incident DB — HIGH risk変更時のみ参照 | ✅ done (`e70aa14`) |
| SP-6 | Pattern Library / Feature DNA — 成功手順の再利用 | ✅ done (`4722330`) |
| SP-7 | Health Score / Self Reflection — 定期・完了時に実行 | ✅ done (`b006b89`) |

---

## SP-1: Project Knowledge Graph — 型定義・Storage・API

### 目的
プロジェクト全体の軽量索引。本文は持たず、メタデータとEdgeだけを管理する。
Context Engine の最初の参照先になる。

### 実装対象

| ファイル | 内容 |
|---------|------|
| `packages/shared/src/types/knowledge_graph.ts` | KGNode / KGEdge / KGNodeType / KGEdgeType 型定義 |
| `packages/shared/src/index.ts` | 型の re-export 追加 |
| `apps/api/src/storage/interface.ts` | IKnowledgeGraphStorage インターフェース追加 |
| `apps/api/src/storage/sqlite.ts` | knowledge_graph_nodes / knowledge_graph_edges テーブル + CRUD |
| `apps/api/src/routes/knowledgeGraph.ts` | CRUD API ルート |
| `apps/api/src/index.ts` | ★ CEO承認対象 — ルート登録 |
| `apps/api/src/routes/knowledgeGraph.test.ts` | APIテスト |

### KGNode スキーマ

```typescript
type KGNodeType = 'feature' | 'phase' | 'task' | 'decision' | 'incident' | 'file' | 'doc'
type KGNodeStatus = 'active' | 'archived' | 'inbox'

interface KGNode {
  id: string              // kg-YYYYMMDD-NNN 形式
  type: KGNodeType
  title: string
  tags: string[]
  phase?: string          // Phase ID（未分類は undefined → inbox 扱い）
  status: KGNodeStatus
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  priority: 'low' | 'medium' | 'high'
  summary?: string        // 1-2行の概要（本文は別ファイル）
  relatedDocs: string[]
  relatedFiles: string[]
  dependsOn: string[]     // KGNode IDs
  blocks: string[]        // KGNode IDs
  relatedFeatures: string[]
  relatedIncidents: string[]
  relatedDecisions: string[]
  historyRefs: string[]
  createdAt: string
  updatedAt: string
}
```

### KGEdge スキーマ

```typescript
type KGEdgeType = 'depends_on' | 'blocks' | 'related_to' | 'belongs_to' | 'impacts'

interface KGEdge {
  id: string              // kge-YYYYMMDD-NNN 形式
  fromNodeId: string
  toNodeId: string
  edgeType: KGEdgeType
  label?: string          // 任意の補足ラベル
  createdAt: string
}
```

### CEO承認対象
`apps/api/src/index.ts` へのルート登録 (`knowledgeGraphRoutes`) は AI編集禁止。
SP-1 完了後に CEO が手動でルート登録するか、別途承認を得て追加する。

### 完了条件
- [ ] 型定義が shared に追加されている
- [ ] storage interface / sqlite 実装が追加されている
- [ ] API routes が実装されている（index.ts 登録は CEO承認後）
- [ ] typecheck 全通過
- [ ] tests 全通過

### コミット
```
feat(knowledge-graph): SP-1 minimum Knowledge Graph node/edge storage and API
```

---

## SP-2: Project Timeline Map（予定）

CEO向け表示。Feature詳細・追加日・履歴・Phase所属を可視化。
SP-1 完了後に設計・実装する。

---

## SP-3: Context Engine 接続（予定）

Task → Knowledge Graph 参照 → Context Pack 生成。
SP-2 完了後に設計・実装する。

---

## SP-4 〜 SP-7（予定）

SP-3 完了後に順次設計・実装する。

---

## 本流復帰ポイント

SP フェーズ完了後は以下に戻る:
- Approval Gate gateProcessor.ts 統合（CEO承認後）
- AV-001 解除後の postTestHook.ps1 統合
