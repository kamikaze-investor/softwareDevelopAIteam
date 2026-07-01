import type {
  ApprovalLevelResult,
  ClassifierInput,
  ClassifierReason,
  ClassifierResult,
  MechanicalGateHit,
  MechanicalGatePattern,
  MechanicalGateResult,
} from './types/approvalLevel'

export const MECHANICAL_GATE_PATTERNS: MechanicalGatePattern[] = [
  {
    id: 'MG-F01',
    label: 'postTestHook.ps1 変更',
    type: 'file',
    pattern: /postTestHook\.ps1$/,
    reason: 'postTestHook.ps1はテスト後処理を制御するためLevel3固定',
  },
  {
    id: 'MG-F02',
    label: 'Meta Review関連コード変更',
    type: 'file',
    pattern: /apps\/worker\/src\/metaReviewer\//,
    reason: 'Meta Review関連コードはレビュー信頼境界のためLevel3固定',
  },
  {
    id: 'MG-F03',
    label: 'Approval Gate 変更',
    type: 'file',
    pattern: /apps\/worker\/src\/guards\/approvalGate\.ts$/,
    reason: 'Approval Gateは承認制御の中核のためLevel3固定',
  },
  {
    id: 'MG-F04',
    label: 'Gate Processor 変更',
    type: 'file',
    pattern: /apps\/worker\/src\/guards\/gateProcessor\.ts$/,
    reason: 'Gate Processorは承認制御の中核のためLevel3固定',
  },
  {
    id: 'MG-F05',
    label: 'Gate Policy 変更',
    type: 'file',
    pattern: /apps\/worker\/src\/guards\/gatePolicy\.ts$/,
    reason: 'Gate Policyは承認制御の中核のためLevel3固定',
  },
  {
    id: 'MG-F06',
    label: 'Permission Guard 変更',
    type: 'file',
    pattern: /apps\/worker\/src\/guards\/permissionGuard\.ts$/,
    reason: 'Permission Guardは権限境界のためLevel3固定',
  },
  {
    id: 'MG-F07',
    label: 'File Change Guard 変更',
    type: 'file',
    pattern: /apps\/worker\/src\/guards\/fileChangeGuard\.ts$/,
    reason: 'File Change Guardは変更範囲制御のためLevel3固定',
  },
  {
    id: 'MG-F08',
    label: 'Safety Auditor 変更',
    type: 'file',
    pattern: /apps\/worker\/src\/guards\/safetyAuditor\.ts$/,
    reason: 'Safety Auditorは安全判定の中核のためLevel3固定',
  },
  {
    id: 'MG-F09',
    label: 'Alignment Checker 変更',
    type: 'file',
    pattern: /apps\/worker\/src\/guards\/alignmentChecker\.ts$/,
    reason: 'Alignment Checkerは指示整合性判定のためLevel3固定',
  },
  {
    id: 'MG-F10',
    label: 'AI CLI Adapter 変更',
    type: 'file',
    pattern: /apps\/worker\/src\/aiCli\/adapter\.ts$/,
    reason: 'AI CLI AdapterはAI実行境界のためLevel3固定',
  },
  {
    id: 'MG-F11',
    label: 'pathUtils 変更',
    type: 'file',
    pattern: /packages\/shared\/src\/utils\/pathUtils\.ts$/,
    reason: 'pathUtilsはパス安全性に関係するためLevel3固定',
  },
  {
    id: 'MG-F12',
    label: 'env ファイル変更',
    type: 'file',
    pattern: /^\.env(\.|$)/,
    reason: 'envファイルは秘密情報や環境設定に関係するためLevel3固定',
  },
  {
    id: 'MG-F13',
    label: 'CI/CD ワークフロー変更',
    type: 'file',
    pattern: /^\.github\/workflows\//,
    reason: 'CI/CDワークフローは自動実行境界のためLevel3固定',
  },
  {
    id: 'MG-F14',
    label: 'docker-compose 設定変更',
    type: 'file',
    pattern: /docker-compose.*\.ya?ml$/i,
    reason: 'docker-compose設定は実行環境に関係するためLevel3固定',
  },
  {
    id: 'MG-F15',
    label: 'Dockerfile 変更',
    type: 'file',
    pattern: /Dockerfile$/,
    reason: 'Dockerfileは実行環境に関係するためLevel3固定',
  },
  {
    id: 'MG-D01',
    label: 'テストスキップ追加',
    type: 'diff',
    pattern: /^\+.*\b(test|it|describe)\.skip\(/m,
    reason: 'テストスキップ追加は品質ゲートを弱めるためLevel3固定',
  },
  {
    id: 'MG-D02',
    label: 'テストスキップ追加（xit/xdescribe）',
    type: 'diff',
    pattern: /^\+.*\bx(it|describe)\(/m,
    reason: 'テストスキップ追加は品質ゲートを弱めるためLevel3固定',
  },
  {
    id: 'MG-D03',
    label: 'Guard 迂回コード追加',
    type: 'diff',
    pattern: /^\+.*(bypass|disable.*guard|ignore.*guard)/im,
    reason: 'Guard迂回コードは安全制御を弱めるためLevel3固定',
  },
  {
    id: 'MG-D04',
    label: 'git hook スキップ追加',
    type: 'diff',
    pattern: /^\+.*--no-verify/m,
    reason: 'git hookスキップは検証を回避するためLevel3固定',
  },
  {
    id: 'MG-D05',
    label: '強制Push追加',
    type: 'diff',
    pattern: /^\+.*(--force\b|force.*push)/im,
    reason: '強制Pushは履歴保護を弱めるためLevel3固定',
  },
  {
    id: 'MG-D06',
    label: 'block/deny→allow の反転',
    type: 'diff',
    pattern: /^\+.*\b(block|deny)\b.*\ballow\b/im,
    reason: '拒否から許可への反転は権限境界を弱めるためLevel3固定',
  },
  {
    id: 'MG-D07',
    label: '空catch（エラー握りつぶし）追加',
    type: 'diff',
    pattern: /^\+.*catch\s*\([^)]*\)\s*\{\s*\}/m,
    reason: '空catchはエラーを握りつぶすためLevel3固定',
  },
  {
    id: 'MG-D08',
    label: 'レビュー/安全確認の無効化',
    type: 'diff',
    pattern: /^\+.*(review.*result|safetyCheck|safety.*verif).*=\s*(null|false|undefined)/im,
    reason: 'レビューや安全確認の無効化は安全制御を弱めるためLevel3固定',
  },
  {
    id: 'MG-D09',
    label: 'APIキーのハードコード',
    type: 'diff',
    pattern: /^\+.*(ANTHROPIC_API_KEY|GEMINI_API_KEY|OPENAI_API_KEY|CLAUDE_API_KEY)\s*=\s*['"]/,
    reason: 'APIキーのハードコードは秘密情報漏えいにつながるためLevel3固定',
  },
  {
    id: 'MG-D10',
    label: 'rm -rf 系の追加',
    type: 'diff',
    pattern: /^\+.*\brm\s+-rf\b/m,
    reason: 'rm -rf系の追加は破壊的操作のためLevel3固定',
  },
  {
    id: 'MG-D11',
    label: '課金/決済関連コード追加',
    type: 'diff',
    pattern: /^\+.*(payment|billing|stripe|課金)/im,
    reason: '課金/決済関連コードは高リスク領域のためLevel3固定',
  },
  {
    id: 'MG-D12',
    label: '本番デプロイ設定変更',
    type: 'diff',
    pattern: /^\+.*(production|prod).*(deploy|config)/im,
    reason: '本番デプロイ設定は運用影響が大きいためLevel3固定',
  },
]

const AI_INSTRUCTION_FILE_PATTERN = /(^|\/)(CLAUDE|AGENTS)\.md$/
const SAFETY_RELEVANT_PATTERN = /auth|token|secret|env|permission|approval|guard|gate|safety|review/i
const VALIDATION_DELETION_PATTERN = /^-.*(\.refine\(|z\.string\(\)\.min\(|\.min\(|\.regex\(|\.email\(|\.url\(|\.uuid\(|\.nonempty\()/m
const REQUIRED_CHECK_DELETION_PATTERN = /^-.*if\s*\(.*required.*\)\s*\{?\s*throw/im

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function normalizeFiles(changedFiles: string[]): string[] {
  return changedFiles.map(normalizePath)
}

function getMechanicalPatternMatch(pattern: MechanicalGatePattern, value: string): string | undefined {
  const match = value.match(pattern.pattern)
  return match?.[0]
}

function buildClassifierResult(
  level: ClassifierResult['level'],
  confidence: number,
  reasons: ClassifierReason[],
  needsEscalation: boolean,
  escalationReason?: string,
): ClassifierResult {
  return {
    level,
    confidence,
    reasons,
    needsEscalation,
    ...(escalationReason ? { escalationReason } : {}),
  }
}

function hasDangerousDiffPattern(diffText: string): boolean {
  return MECHANICAL_GATE_PATTERNS.some(pattern =>
    pattern.type === 'diff' && pattern.pattern.test(diffText),
  )
}

function hasAiInstructionFile(changedFiles: string[]): boolean {
  return changedFiles.some(file => AI_INSTRUCTION_FILE_PATTERN.test(file))
}

function detectAiInstructionSafetyChange(diffText: string): ClassifierReason[] {
  const reasons: ClassifierReason[] = []

  if (/^-.*(禁止.*削除|してはいけない.*削除)/m.test(diffText) ||
      /^\+.*(承認不要|自動承認|チェック不要|スキップ可)/m.test(diffText)) {
    reasons.push({
      rule: 'CLAUDE_AGENTS_SAFETY_WEAKENING',
      detail: 'CLAUDE.md/AGENTS.mdで安全ルール弱体化を示す変更を検出',
    })
  }

  if (/^[+-].*(Guard|Gate|Meta Review|postTestHook|Secret Scan)/im.test(diffText)) {
    reasons.push({
      rule: 'CLAUDE_AGENTS_GUARD_REVIEW_CHANGE',
      detail: 'CLAUDE.md/AGENTS.mdでGuard/Gate/Meta Review/postTestHook/Secret Scan関連行の変更を検出',
    })
  }

  if (/^\+.*(canModifyFiles.*true|canExecuteCommands.*true|canCommit.*true)/m.test(diffText)) {
    reasons.push({
      rule: 'CLAUDE_AGENTS_AI_PERMISSION_EXPANSION',
      detail: 'CLAUDE.md/AGENTS.mdでAI権限拡大を示す変更を検出',
    })
  }

  return reasons
}

function hasRequiredToOptionalChange(diffText: string): boolean {
  return /\.optional\(\)/.test(diffText) || /required.*optional/i.test(diffText)
}

function hasSafetyRelevantOptionalChange(changedFiles: string[], diffText: string): boolean {
  const joinedInput = `${changedFiles.join('\n')}\n${diffText}`

  return SAFETY_RELEVANT_PATTERN.test(joinedInput) ||
    VALIDATION_DELETION_PATTERN.test(diffText) ||
    REQUIRED_CHECK_DELETION_PATTERN.test(diffText)
}

function detectLevel2Reasons(input: ClassifierInput, changedFiles: string[], diffText: string): ClassifierReason[] {
  const reasons: ClassifierReason[] = []

  if (input.jobRunnerTouched) {
    reasons.push({
      rule: 'JOB_RUNNER_TOUCHED',
      file: changedFiles.find(file => /apps\/worker\/src\/jobRunner\.ts$/.test(file)),
      detail: 'jobRunner.tsに関係する変更のためLevel2',
    })
  }

  if (input.aiCliPathTouched) {
    reasons.push({
      rule: 'AI_CLI_PATH_TOUCHED',
      file: changedFiles.find(file => /apps\/worker\/src\/aiCli\//.test(file)),
      detail: 'AI CLI関連パスに関係する変更のためLevel2',
    })
  }

  if (input.contextFilesTouched) {
    reasons.push({
      rule: 'CONTEXT_FILES_TOUCHED',
      file: changedFiles.find(file => /context|CLAUDE\.md$|AGENTS\.md$|project_memory/.test(file)),
      detail: 'Context PackまたはAI指示文に関係する変更のためLevel2',
    })
  }

  const guardFile = changedFiles.find(file => /apps\/worker\/src\/guards\//.test(file))
  if (guardFile) {
    reasons.push({
      rule: 'GUARDS_PATH_TOUCHED',
      file: guardFile,
      detail: 'Mechanical Gate対象外のguards配下変更のためLevel2',
    })
  }

  const schemaFile = changedFiles.find(file => /schema\.ts$|migration/i.test(file))
  if (schemaFile) {
    reasons.push({
      rule: 'DB_SCHEMA_OR_MIGRATION',
      file: schemaFile,
      detail: 'DB schemaまたはmigration変更のためLevel2',
    })
  }

  if (hasExternalApiAddition(changedFiles, diffText)) {
    reasons.push({
      rule: 'EXTERNAL_API_ADDITION',
      detail: '外部API呼び出し追加を示唆する変更のためLevel2',
    })
  }

  if (input.taskKind === 'context_files_extension' || input.taskKind === 'job_runner_change') {
    reasons.push({
      rule: 'TASK_KIND_LEVEL2',
      detail: `taskKind=${input.taskKind} のためLevel2`,
    })
  }

  return reasons
}

function hasExternalApiAddition(changedFiles: string[], diffText: string): boolean {
  const hasNonWorkflowFile = changedFiles.some(file => !/^\.github\//.test(file))
  const hasHttpCall = /^\+.*\b(fetch|axios)\s*\(/m.test(diffText)
  const hasNewImport = /^\+.*import\s+.*\b(axios|fetch|node-fetch|undici)\b/m.test(diffText) ||
    /^\+.*from\s+['"](axios|node-fetch|undici)['"]/m.test(diffText)

  return hasNonWorkflowFile && hasHttpCall && hasNewImport
}

function calculateLevel2Confidence(input: ClassifierInput, reasons: ClassifierReason[]): number {
  const flagCount = [
    input.jobRunnerTouched,
    input.aiCliPathTouched,
    input.contextFilesTouched,
  ].filter(Boolean).length

  if (flagCount > 1) {
    return Math.min(0.95, 0.88 + flagCount * 0.025)
  }

  if (input.jobRunnerTouched) {
    return 0.93
  }

  if (input.aiCliPathTouched) {
    return 0.88
  }

  if (input.contextFilesTouched) {
    return 0.85
  }

  return reasons.length > 0 ? 0.85 : 0.4
}

function hasMeaningfulDeletion(diffText: string): boolean {
  return /^-(?!---).*\S/m.test(diffText)
}

function isRouteZodSchemaExtension(file: string, diffText: string): boolean {
  return /\/routes\/.*\.ts$/.test(file) &&
    /^\+.*\bz\.(object|string|number|boolean|array|enum|nativeEnum|literal|union|record)/m.test(diffText) &&
    !hasMeaningfulDeletion(diffText)
}

function classifyLevel1File(file: string, diffText: string): string | undefined {
  if (/^packages\/shared\/src\/types\/.*\.ts$/.test(file)) {
    return 'type-definition'
  }

  if (isRouteZodSchemaExtension(file, diffText)) {
    return 'zod-schema'
  }

  if (/^packages\/shared\/src\/.*\.ts$/.test(file) &&
      /^\+.*\b(export|interface|type|const|function)\b/m.test(diffText) &&
      !hasMeaningfulDeletion(diffText)) {
    return 'non-breaking-extension'
  }

  return undefined
}

function isNewTestFile(file: string, diffText: string): boolean {
  if (!/\.test\.ts$/.test(file)) {
    return false
  }

  if (diffText.trim() === '') {
    return true
  }

  const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const existingFileMarker = new RegExp(`^--- a/${escapedFile}$`, 'm')

  return !existingFileMarker.test(diffText) || /^new file mode|^--- \/dev\/null/m.test(diffText)
}

function isLevel0File(file: string, diffText: string): boolean {
  return (/^docs\//.test(file) && !AI_INSTRUCTION_FILE_PATTERN.test(file)) ||
    /^README/i.test(file) ||
    /^\.gitignore$/.test(file) ||
    isNewTestFile(file, diffText) ||
    /^logs\//.test(file)
}

function deriveJobRunnerTouched(changedFiles: string[]): boolean {
  return changedFiles.some(file => /apps\/worker\/src\/jobRunner\.ts$/.test(file))
}

function deriveAiCliPathTouched(changedFiles: string[]): boolean {
  return changedFiles.some(file => /apps\/worker\/src\/aiCli\//.test(file))
}

function deriveContextFilesTouched(changedFiles: string[]): boolean {
  return changedFiles.some(file =>
    AI_INSTRUCTION_FILE_PATTERN.test(file) ||
    /(^|\/)context/i.test(file) ||
    /^docs\/project_memory\//.test(file) ||
    /^specs\//.test(file),
  )
}

function requiresChatGptReviewForClassifierResult(classifierResult: ClassifierResult): boolean {
  const chatGptEscalationRules = new Set([
    'CLAUDE_AGENTS_SAFETY_WEAKENING',
    'CLAUDE_AGENTS_GUARD_REVIEW_CHANGE',
    'CLAUDE_AGENTS_AI_PERMISSION_EXPANSION',
    'REQUIRED_OPTIONAL_SAFETY_WEAKENING',
  ])

  return classifierResult.level === 3 ||
    classifierResult.confidence < 0.5 ||
    classifierResult.reasons.some(reason => chatGptEscalationRules.has(reason.rule))
}

export function runMechanicalGate(changedFiles: string[], diffText: string): MechanicalGateResult {
  const hits: MechanicalGateHit[] = []
  const normalizedFiles = normalizeFiles(changedFiles)

  for (const file of normalizedFiles) {
    for (const pattern of MECHANICAL_GATE_PATTERNS) {
      if (pattern.type !== 'file') {
        continue
      }

      if (pattern.pattern.test(file)) {
        hits.push({
          patternId: pattern.id,
          label: pattern.label,
          reason: pattern.reason,
          matched: file,
        })
      }
    }
  }

  for (const pattern of MECHANICAL_GATE_PATTERNS) {
    if (pattern.type !== 'diff') {
      continue
    }

    const matched = getMechanicalPatternMatch(pattern, diffText)
    if (matched) {
      hits.push({
        patternId: pattern.id,
        label: pattern.label,
        reason: pattern.reason,
        matched,
      })
    }
  }

  return {
    triggered: hits.length > 0,
    hits,
  }
}

export function classifyApprovalLevel(input: ClassifierInput): ClassifierResult {
  const changedFiles = normalizeFiles(input.changedFiles)
  const { diffText } = input

  if (changedFiles.length === 0 && diffText.trim() === '') {
    return buildClassifierResult(
      3,
      0.3,
      [{ rule: 'FAIL_CLOSED_NO_INPUT', detail: '変更情報が空のため判定不能' }],
      true,
      '入力情報が空',
    )
  }

  if (changedFiles.length > 30) {
    return buildClassifierResult(
      3,
      0.6,
      [{
        rule: 'MAX_FILES_EXCEEDED',
        detail: `変更ファイル数 ${changedFiles.length} が上限30を超過`,
      }],
      true,
      '大量変更のため要人間確認',
    )
  }

  if (hasAiInstructionFile(changedFiles)) {
    const safetyReasons = detectAiInstructionSafetyChange(diffText)

    if (safetyReasons.length > 0) {
      return buildClassifierResult(
        3,
        0.7,
        safetyReasons,
        true,
        'CLAUDE.md/AGENTS.mdの安全関連記述変更',
      )
    }

    return buildClassifierResult(
      2,
      0.8,
      [{
        rule: 'CLAUDE_AGENTS_TEXT_CHANGE',
        file: changedFiles.find(file => AI_INSTRUCTION_FILE_PATTERN.test(file)),
        detail: 'CLAUDE.md/AGENTS.mdの変更のためLevel2',
      }],
      false,
    )
  }

  if (hasRequiredToOptionalChange(diffText)) {
    if (hasSafetyRelevantOptionalChange(changedFiles, diffText)) {
      return buildClassifierResult(
        3,
        0.75,
        [{
          rule: 'REQUIRED_OPTIONAL_SAFETY_WEAKENING',
          detail: 'required→optional化と安全条件緩和の疑いを検出',
        }],
        true,
        'optional化+安全条件緩和の疑い',
      )
    }

    return buildClassifierResult(
      2,
      0.82,
      [{
        rule: 'REQUIRED_OPTIONAL_REVIEW_REQUIRED',
        detail: 'required→optional化のためLevel2で意図確認',
      }],
      true,
      'required→optional化のためAIレビューで意図確認',
    )
  }

  const level2Reasons = detectLevel2Reasons(input, changedFiles, diffText)
  if (level2Reasons.length > 0) {
    return buildClassifierResult(
      2,
      calculateLevel2Confidence(input, level2Reasons),
      level2Reasons,
      false,
    )
  }

  const hasDangerousPattern = hasDangerousDiffPattern(diffText)

  if (!hasDangerousPattern && changedFiles.length > 0) {
    const level1Kinds = new Set<string>()
    const allLevel1 = changedFiles.every(file => {
      const kind = classifyLevel1File(file, diffText)
      if (kind) {
        level1Kinds.add(kind)
      }
      return Boolean(kind)
    })

    if (allLevel1) {
      return buildClassifierResult(
        1,
        Math.min(0.9, 0.86 + level1Kinds.size * 0.01),
        [{
          rule: 'SAFE_EXTENSION_ONLY',
          detail: '型定義、Zodスキーマ、または非破壊的拡張に限定された変更',
        }],
        false,
      )
    }
  }

  if (!hasDangerousPattern &&
      changedFiles.length > 0 &&
      changedFiles.every(file => isLevel0File(file, diffText))) {
    return buildClassifierResult(
      0,
      0.95,
      [{
        rule: 'SAFE_AUTOMATIC_FILES_ONLY',
        detail: 'docs/README/.gitignore/新規テスト/logsのみの変更',
      }],
      false,
    )
  }

  return buildClassifierResult(
    3,
    0.4,
    [{ rule: 'UNMATCHED_FALLBACK', detail: '既知のルールに一致しないため安全側でLevel3' }],
    true,
    '未知パターンのため人間確認が必要',
  )
}

export function shouldEscalateToAiReview(result: ClassifierResult): boolean {
  if (result.needsEscalation) {
    return true
  }

  return result.confidence < 0.85
}

export function determineApprovalLevel(
  jobId: string,
  taskId: string,
  changedFiles: string[],
  diffText: string,
  taskKind?: string,
): ApprovalLevelResult {
  const normalizedFiles = normalizeFiles(changedFiles)
  const mechanicalGate = runMechanicalGate(normalizedFiles, diffText)

  if (mechanicalGate.triggered) {
    const classifierResult: ClassifierResult = {
      level: 3,
      confidence: 1.0,
      reasons: mechanicalGate.hits.map(hit => ({
        rule: `MECHANICAL_GATE_${hit.patternId}`,
        detail: hit.reason,
      })),
      needsEscalation: false,
    }

    return {
      jobId,
      taskId,
      level: 3,
      confidence: 1.0,
      mechanicalGate,
      classifierResult,
      finalReason: `Mechanical Gate: ${mechanicalGate.hits.map(hit => hit.label).join(', ')}`,
      decidedAt: new Date().toISOString(),
      requiresChatGptReview: true,
    }
  }

  const classifierResult = classifyApprovalLevel({
    changedFiles: normalizedFiles,
    diffText,
    taskKind,
    jobRunnerTouched: deriveJobRunnerTouched(normalizedFiles),
    aiCliPathTouched: deriveAiCliPathTouched(normalizedFiles),
    contextFilesTouched: deriveContextFilesTouched(normalizedFiles),
  })

  // MVPではChatGPT API未接続のため、このフラグは実際のAPI呼び出しを意味しない。
  // 将来のCost-aware Review RouterでChatGPTレビューへ昇格するための判定フラグ。
  const requiresChatGptReview = requiresChatGptReviewForClassifierResult(classifierResult)

  return {
    jobId,
    taskId,
    level: classifierResult.level,
    confidence: classifierResult.confidence,
    mechanicalGate,
    classifierResult,
    finalReason: classifierResult.reasons.map(reason => reason.detail).join('; '),
    decidedAt: new Date().toISOString(),
    requiresChatGptReview,
  }
}
