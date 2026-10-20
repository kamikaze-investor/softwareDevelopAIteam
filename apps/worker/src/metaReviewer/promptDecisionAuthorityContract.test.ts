import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMetaReviewPrompt, buildMetaReviewRequest } from './runner.js'

/**
 * Meta Reviewer の判定契約（docs/meta_reviewer/prompt.md / checklist.md）のうち、
 * Human Decision lifecycle（2026-10-08 CEO 決定）が依存する意味を固定する。
 *
 * 逆戻りさせたくない意味:
 *   canonical spec で承認済みの authority boundary を、その scope どおりに実装する変更は、
 *   人の承認を外す方向であっても technical `blocked`（Cage 弱体化）ではなく Human Decision Authority である。
 *   `blocked` は、承認済み scope の逸脱・無断の authority 拡大・意図しない bypass / fail-open・実装欠陥だけ。
 *
 * これが崩れると、CEO が spec で承認した変更自体が Meta Review で止まり、
 * Human Decision（CODEOWNERS review）へ到達できなくなる（実測: Stage 1 git_commit 実装の PR）。
 * 特定の PR / SHA には依存させず、prompt / checklist の本文の意味だけを見る。
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const prompt = readFileSync(path.join(REPO_ROOT, 'docs/meta_reviewer/prompt.md'), 'utf-8')
const checklist = readFileSync(path.join(REPO_ROOT, 'docs/meta_reviewer/checklist.md'), 'utf-8')

/** 見出し `heading` から次の `### ` / `## ` 見出しまでの本文。 */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  expect(start, `heading not found: ${heading}`).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start + heading.length)
  const next = rest.search(/\n#{2,3} /)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('Meta Reviewer 判定契約 — 承認済み authority boundary の扱い', () => {
  const blockedSection = section(prompt, '### `blocked`')
  const humanDecisionSection = section(prompt, '### Human Decision Authority のみ')

  it('承認済み boundary を scope どおりに実装する変更は、Tuple を変えるなら Human Decision 側に置かれ、blocked にしない', () => {
    expect(humanDecisionSection).toContain('canonical spec で承認済みの authority boundary を、その scope どおりに変更・実装する差分は、それが現行の Approval Tuple (a)〜(d) を実際に変える場合')
    expect(humanDecisionSection).toContain('Cage 弱体化 / Safety weakening として `blocked` にしない')
  })

  it('authority を広げること自体は blocked の理由にならない', () => {
    expect(humanDecisionSection).toContain('authority を広げる変更であること自体は `blocked` の理由にならない')
  })

  it('blocked 側の Human Gate 弱体化は「承認されていない（無断・意図外）」場合に限られる', () => {
    expect(blockedSection).toContain('canonical spec で承認されていないのに保護が弱まる方向へ変えている')
    // 無条件の「Human Gate を弱めたら blocked」に戻っていないこと
    expect(blockedSection).not.toMatch(/Human Gate そのもの[^\n]*を、保護が弱まる方向へ変えている/)
  })

  it('承認済み scope を超えた authority 拡大と実装欠陥は引き続き blocked', () => {
    expect(blockedSection).toContain('CEO が承認した scope（canonical spec）を超えて authority を広げている')
    expect(blockedSection).toContain('意図しない bypass・fail-open・判定漏れ')
  })

  it('PR 自身による canonical spec の変更で自分の scope を正当化しない', () => {
    expect(humanDecisionSection).toContain('その変更を根拠に自分の scope を正当化しない')
  })

  it('CEO 承認は technical blocked を解除しない（欠陥と Human Decision の両方なら blocked）', () => {
    expect(humanDecisionSection).toContain('CEO 承認は技術的な `blocked` を解除しない')
  })

  it('checklist も同じ意味: 承認済み boundary の scope 内実装を Cage 弱体化に数えない', () => {
    expect(checklist).toContain('scope どおりに実装する変更は、人の承認を外す方向でも「Cage弱体化」に数えない')
  })
})

describe('Meta Reviewer 判定契約 — DA trigger (1) は文書ではなく意味の変更', () => {
  const contractDocuments = [
    ['prompt', prompt],
    ['checklist', checklist],
  ] as const

  it.each(contractDocuments)('%s は DA (1) を意味で判定し、ファイル編集だけでは A にしない', (_name, document) => {
    expect(document).toContain('DA (1) はファイル名ではなく差分の意味で判定する')
    expect(document).toContain('Goal・事業上の Goal 優先順位・Product / Business 方針・Design Philosophy / Constitution の原則・Policy / Value の**意味の変更**')
    expect(document).toContain('`tasks/roadmap.md` や `docs/PROJECT_CURRENT_STATE.md` の編集')
    expect(document).toContain('ファイル名・「roadmap」という語・記録済み CEO instruction・HIGH / Production risk だけでは A にしない')
  })

  it.each(contractDocuments)('%s は roadmap evidence・technical item 等を B / C とする', (_name, document) => {
    expect(document).toContain('調査結果・evidence の記録、進捗・state 更新')
    expect(document).toContain('既存 Goal 内の technical-fix item 追加、実装順・技術的 priority')
    expect(document).toContain('機械的な `PROJECT_CURRENT_STATE` sync は B / C')
  })

  it.each(contractDocuments)('%s は意味を変える A の例と CEO approval を維持する', (_name, document) => {
    expect(document).toContain('Goal / Product 方針、事業上の優先順位・トレードオフ')
    expect(document).toContain('Design Philosophy / Policy / Value、authority / Safety boundary の意味を変える差分は A')
    expect(document).toContain('`requiresCeoApproval: true` を返す')
  })
})

describe('Meta Reviewer 判定契約 — DA trigger (2) は Approval Tuple の意味で判定する', () => {
  const DA2_HEADING = '### DA trigger (2) — Authority / Approval boundary の意味で判定する'
  const CHECKLIST_DA2_HEADING = '#### DA (2): Approval Tuple の意味確認'
  const da2Section = section(prompt, DA2_HEADING)
  const checklistDa2 = checklist.slice(checklist.indexOf(CHECKLIST_DA2_HEADING))
  const humanDecisionSection = section(prompt, '### Human Decision Authority のみ')
  const contractDocuments = [
    ['prompt', da2Section],
    ['checklist', checklistDa2],
  ] as const

  it('checklist にも DA (2) の Approval Tuple 確認ブロックがあり、prompt の節を参照する', () => {
    expect(checklist.indexOf(CHECKLIST_DA2_HEADING)).toBeGreaterThanOrEqual(0)
    expect(checklistDa2).toContain('`prompt.md`「DA trigger (2) — Authority / Approval boundary の意味で判定する」')
  })

  // 1
  it.each(contractDocuments)('%s は Approval Tuple (a)〜(d) を定義する', (_name, document) => {
    expect(document).toContain('Approval Tuple')
    for (const element of ['(a)', '(b)', '(c)', '(d)']) expect(document).toContain(element)
  })

  it('prompt の (a)〜(d) は承認者・対象 action・binding・effect を指す', () => {
    expect(da2Section).toContain('- (a) 誰が承認者として数えられるか')
    expect(da2Section).toContain('- (b) 何が人の承認を必要とするか')
    expect(da2Section).toContain('- (c) 承認が何に束縛されるか')
    expect(da2Section).toContain('- (d) 承認が何を許可するか')
  })

  // 2
  it('拡大・縮小・置換の全方向が A になる', () => {
    expect(da2Section).toContain('追加・削除・拡大・縮小・置換する差分は、方向を問わず A とし、`requiresCeoApproval: true` を返す')
    expect(da2Section).toContain('承認effectの拡大と縮小はどちらも Human Decision Authority である')
    expect(checklistDa2).toContain('拡大だけでなく縮小・置換もAとしている')
  })

  // 3
  it('ラベル・commit message・ファイル名は証拠にならない', () => {
    expect(da2Section).toContain('DA (2) はファイル名、変更ラベル、commit message、または「強化」「hardening」「既存authorityの実装」という自己申告では判定しない')
    expect(checklistDa2).toContain('ファイル名・commit message・「強化」「hardening」「refactor」等のラベルではなく、実際の差分を見た')
  })

  // 4
  it('Tuple を変えない enforcement-only repair は B になり得る', () => {
    expect(da2Section).toContain('canonical rule が既に定めた同一の Approval Tuple を、欠落・不整合・race・bypass候補の修正によって正しく強制するだけの変更は B である')
    expect(da2Section).toContain('B とするには、少なくとも次を満たさなければならない')
    expect(checklistDa2).toContain('Tuple不変のenforcement-only repairはB（`requiresCeoApproval: false`）とした')
  })

  // 5
  it('判定できない場合は A へ fail closed', () => {
    expect(da2Section).toContain('差分が (a)〜(d) またはSafety boundaryを変えるか判定できない場合は A に倒す')
    expect(checklistDa2).toContain('unclearまたは証拠不足ならAへ倒した')
  })

  // 6
  it('status と requiresCeoApproval は独立', () => {
    expect(da2Section).toContain('Decision Authority と技術statusは独立である')
    expect(prompt).toContain('`status` は技術的な判定、`requiresCeoApproval` は Human Decision Authority の要否であり、互いに独立に決めること。')
    expect(checklistDa2).toContain('technical statusとrequiresCeoApprovalを独立に決めた')
  })

  // 7
  it('A + blocked と B + blocked を含む4通りの matrix が明記される', () => {
    expect(da2Section).toContain('- Tuple変更あり、欠陥なし: A + approved / changes_requested')
    expect(da2Section).toContain('- Tuple変更あり、bypass・fail-open・判定漏れあり: A + blocked')
    expect(da2Section).toContain('- Tuple変更なしのenforcement repair、欠陥なし: B + approved / changes_requested')
    expect(da2Section).toContain('- Tuple変更なしのenforcement repair、欠陥あり: B + blocked')
    expect(da2Section).toContain('欠陥だけを理由にAへ変更しない')
    expect(checklistDa2).toContain('Tuple不変のenforcement defectはB + blocked、Tupleを実際に変えるdefectはA + blockedとした')
  })

  // 8
  it('legacy の human 化・hash→path binding・TTL 延長・check skip・default approve は A + blocked', () => {
    expect(da2Section).toContain('- legacy / unknown の actor を human と数える（(a) の変更）→ A + blocked')
    expect(da2Section).toContain('- exact diff hash による binding を changedPaths の集合一致等へ置き換える（(c) の変更）→ A + blocked')
    expect(da2Section).toContain('- 承認の TTL を canonical rule より延長する、または期限切れ時に再延長する（(d) の変更）→ A + blocked')
    expect(da2Section).toContain('- 共通 check の refactor 後、一部の route / action だけ check を通らない（実行 path 単位の (b)〜(d) の変更）→ A + blocked')
    expect(da2Section).toContain('- unknown / default の判定を deny から approve に変える（未確定値の effect の変更）→ A + blocked')
    expect(checklistDa2).toContain('legacy / unknown を human と数える、exact diff hash binding を path 集合等へ緩める、TTL 延長・再延長、一部 path での check skip、unknown / default を approve にする変更は A + blocked とした')
  })

  // 9
  it('human-approval action の追加と auto-commit effect への変更は A', () => {
    expect(da2Section).toContain('- human-approval 対象の action を追加する（(b) の拡大）→ A（欠陥が無ければ blocked にしない）')
    expect(da2Section).toContain('- 承認の effect を「commit 準備の許可」から自動 commit へ変える（(d) の変更）→ A')
    expect(checklistDa2).toContain('human-approval 対象 action の追加、承認 effect を自動 commit へ変える変更は A とした')
  })

  // 10
  it('canonical spec が承認済みの Tuple 変更（Stage 1 型）は A のままで、欠陥が無ければ blocked にしない', () => {
    expect(humanDecisionSection).toContain('それが現行の Approval Tuple (a)〜(d) を実際に変える場合、人の承認を外す方向であっても A（Human Decision Authority）であり、Cage 弱体化 / Safety weakening として `blocked` にしない')
    expect(humanDecisionSection).toContain('git_commit から人の承認を外すので (b) が変わり A のまま、欠陥が無ければ `blocked` にしない')
    expect(da2Section).toContain('- human-approval 対象から action を削除する（(b) の縮小）→ A（canonical spec が承認済みで欠陥が無ければ blocked にしない）')
    expect(checklist).toContain('それが現行の Approval Tuple (a)〜(d) を実際に変える場合（例: git_commit Stage 1 で人の承認を外す）は A（`requiresCeoApproval: true`）のままで、欠陥が無ければ `blocked` にしない')
    expect(checklistDa2).toContain('canonical spec が承認済みの Tuple 変更（例: git_commit Stage 1）は A のままとし、欠陥が無ければ blocked にしていない')
  })

  // 11
  it('authority 関連ファイル名だけでは A にしない', () => {
    expect(da2Section).toContain('authority関連ファイル、Gate、permission、guard、commitGate、actor provenance、expiry、invalidation等を変更するという理由だけでは A にしない')
    expect(humanDecisionSection).toContain('Tuple を変えずに既存 rule を正しく強制するだけの enforcement repair は DA (2) ではなく B（`requiresCeoApproval: false`）である')
    expect(checklistDa2).toContain('authority 関連ファイル名だけでは A にしていない')
    // DA trigger 一覧の (2) も Tuple 判定へ誘導する
    for (const document of [prompt, checklist]) {
      expect(document).toContain('該当するかはファイル名・ラベルではなく、差分が実際に変える Approval Tuple (a)〜(d) で判定する')
    }
  })

  // 12
  it('特定 PR・特定ファイルに限定しない', () => {
    expect(da2Section).toContain('このルールは特定PRや特定ファイルに限定せず')
    expect(checklistDa2).toContain('この確認を特定PR・特定ファイルに限定せず')
    // 契約本文に PR 番号・SHA を埋め込まない
    for (const document of [da2Section, checklistDa2]) {
      expect(document).not.toMatch(/#\d{2,}/)
      expect(document).not.toMatch(/\b[0-9a-f]{7,40}\b/)
    }
  })

  it('DA (2) 節は blocked と Human Decision Authority の間にあり、旧来の「判定不能な authority 定義変更は一律ここ」だけの文に戻っていない', () => {
    expect(prompt.indexOf('### `blocked`')).toBeLessThan(prompt.indexOf(DA2_HEADING))
    expect(prompt.indexOf(DA2_HEADING)).toBeLessThan(prompt.indexOf('### Human Decision Authority のみ'))
    expect(prompt).not.toContain('- 強化か弱化かを機械判定できない authority 定義の変更（DA (2)）も、欠陥が無ければここに入る')
  })
})

describe('Meta Reviewer 判定契約 — DA (2) の rule は実際に model へ渡る prompt に全文入る', () => {
  it.each([
    ['apps/api/src/designReview/resumeActor.ts'],
    ['packages/shared/src/approvalGateLogic.ts'],
  ])('%s を触る diff の Meta Review prompt に Approval Tuple rule と B/A matrix が切り詰められずに入る', (changedFile) => {
    const diff = `diff --git a/${changedFile} b/${changedFile}\n--- a/${changedFile}\n+++ b/${changedFile}\n@@ -1 +1 @@\n-old\n+new\n`
    const request = buildMetaReviewRequest('task-da2', 'DA (2) prompt delivery', [changedFile], REPO_ROOT, diff)
    const built = buildMetaReviewPrompt(request, REPO_ROOT)

    // prompt.md と checklist.md は全文そのまま入る（途中で切られていない）
    expect(built).toContain(prompt)
    expect(built).toContain(checklist)

    expect(built).toContain('### DA trigger (2) — Authority / Approval boundary の意味で判定する')
    expect(built).toContain('- (a) 誰が承認者として数えられるか')
    expect(built).toContain('- (d) 承認が何を許可するか')
    expect(built).toContain('- Tuple変更あり、欠陥なし: A + approved / changes_requested')
    expect(built).toContain('- Tuple変更あり、bypass・fail-open・判定漏れあり: A + blocked')
    expect(built).toContain('- Tuple変更なしのenforcement repair、欠陥なし: B + approved / changes_requested')
    expect(built).toContain('- Tuple変更なしのenforcement repair、欠陥あり: B + blocked')
    expect(built).toContain('#### DA (2): Approval Tuple の意味確認')

    // rule は diff より前にあり、prompt は末尾の回答指示まで揃っている
    expect(built.indexOf('### DA trigger (2)')).toBeLessThan(built.indexOf('**Git Diff**:'))
    expect(built).toContain(diff)
    expect(built.trimEnd().endsWith('上記のdiffを確認し、MetaReviewResultのJSON形式で回答してください。')).toBe(true)
  })
})
