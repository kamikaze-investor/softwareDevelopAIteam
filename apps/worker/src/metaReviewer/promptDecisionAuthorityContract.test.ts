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

  it('承認済み boundary の実装は、base rule が exact Tuple を定めていれば B、原則だけなら Tuple を変える限り A で、どちらも blocked にしない', () => {
    expect(humanDecisionSection).toContain('canonical spec で承認済みの authority boundary を実装する差分の扱いは、base canonical rule が具体的な Tuple を定めているかで決まる')
    expect(humanDecisionSection).toContain('実装が全 path でそれと一致する場合は B（`requiresCeoApproval: false`。2回目の CEO review は不要）')
    expect(humanDecisionSection).toContain('原則・方針としての散文承認だけで具体的な Tuple binding が無い boundary を実装し、現行の Approval Tuple (a)〜(d) を実際に変える場合は')
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
  it('Tuple の基準点は base の承認済み canonical rule: exact Tuple の実装は B、原則だけの承認（Stage 1 型）は A で欠陥が無ければ blocked にしない', () => {
    expect(da2Section).toContain('**基準点 — Approval Tuple の変化は base branch の承認済み canonical rule に対して測る**')
    expect(da2Section).toContain('差分の実行時挙動が全 path でその Tuple と一致する場合は enforcement であり B（`requiresCeoApproval: false`）とする。コードの従来挙動を変える場合も同じである。')
    expect(da2Section).toContain('base canonical rule を超える、またはそれと異なる Tuple 変更は A とする。rule と実装の不一致は A + blocked とする。')
    expect(da2Section).toContain('具体的な Tuple（old→new）を定めていない boundary の実装は、基準となる Tuple が無いので A のままとする。')
    expect(da2Section).toContain('承認済み rule を正確に実装する差分には2回目の CEO review を求めない')
    expect(humanDecisionSection).toContain('§14-3 は境界を定めるが `approval_rules.md` に exact Tuple binding が無いので、git_commit から人の承認を外す実装は (b) が変わり A のまま、欠陥が無ければ `blocked` にしない')
    expect(da2Section).toContain('base canonical rule がその削除を old→new として具体的に定義済みで実装が一致するなら B）')
    expect(checklist).toContain('base rule が old→new Tuple を具体的に定義済みで実装が全 path で一致すれば B（`requiresCeoApproval: false`。2回目の CEO review は不要）')
    expect(checklist).toContain('（例: git_commit Stage 1 で人の承認を外す。`approval_rules.md` に exact binding が無い）は A（`requiresCeoApproval: true`）のままで、欠陥が無ければ `blocked` にしない')
    expect(checklistDa2).toContain('原則としてのみ承認済みで exact Tuple binding が無い Tuple 変更（例: git_commit Stage 1）は A のままとし、欠陥が無ければ blocked にしていない')
    expect(checklistDa2).toContain('base canonical rule が old→new として具体的に定義済みの Tuple を全 path で一致させて実装する変更は B とし、不一致は A + blocked とした')
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

describe('Meta Reviewer 判定契約 — Approval Tuple を実際に変える A は rule と実装を同じ PR で CODEOWNERS review へ出す', () => {
  const da2Section = section(prompt, '### DA trigger (2) — Authority / Approval boundary の意味で判定する')
  const checklistDa2 = checklist.slice(checklist.indexOf('#### DA (2): Approval Tuple の意味確認'))
  const humanDecisionSection = section(prompt, '### Human Decision Authority のみ')

  it('mechanism: canonical rule の実質的変更または activation binding を同じ PR に含め、CODEOWNERS review に委ねる（base rule の exact Tuple 実装は B）', () => {
    expect(da2Section).toContain('基準点（base canonical rule）に対して Approval Tuple (a)〜(d) を実際に変える変更（A）は、対応する canonical rule（`docs/project_memory/rules/approval_rules.md` または `specs/22`）の実質的な変更（old→new Tuple の定義）、または原則としてのみ承認済みの boundary に具体的な Tuple を与える activation binding を同じ PR に含め、CODEOWNERS review に委ねる。base canonical rule が exact Tuple を既に定めている実装はこれに当たらず、B である。')
    expect(da2Section).toContain('実装が CODEOWNERS 外のファイルでも同じ')
    expect(checklistDa2).toContain('原則としてのみ承認済みの boundary への activation binding を同じ PR に含め、CODEOWNERS review に委ねている')
  })

  it('同じ PR の rule 変更は既承認の根拠ではなく、承認前は効力を持たない proposal である', () => {
    expect(da2Section).toContain('同じ PR の canonical rule 変更は既承認の根拠として扱わない。ただし old→new Approval Tuple を具体的に定義し実装差分と一致する場合は、PR 全体を A として CODEOWNERS review へ委ねるための proposal として扱う。承認前は効力を持たず、実装欠陥・bypass・rule/code 不一致を解除しない。')
  })

  it('5点確認: old/new tuple・scope 等・全 path 一致・fail closed・不一致は A + blocked', () => {
    expect(da2Section).toContain('1. rule の差分が old と new の Approval Tuple を実質的に記述している。')
    expect(da2Section).toContain('2. rule が scope・binding・effect・expiry / use / reset・failure default を定めている。')
    expect(da2Section).toContain('3. 実装が全 writer・reader・consume・retry・recovery・alternate path で rule と一致している。')
    expect(da2Section).toContain('4. missing・legacy・unknown evidence は fail closed のままである。')
    expect(da2Section).toContain('5. rule と code が一致しない場合は A + blocked であり、CEO review はそれを解除しない。')
    expect(checklistDa2).toContain('rule が old→new Tuple と scope・binding・effect・expiry / use / reset・failure default を定め、全 writer / reader / consume / retry / recovery / alternate path の実装と一致し、missing / legacy / unknown は fail closed')
    expect(checklistDa2).toContain('rule と code の不一致は A + blocked とし、CEO review で解除されるものとして扱っていない')
  })

  it('Human Gate を得るためだけの保護対象編集は manipulation として blocked', () => {
    expect(da2Section).toContain('Human Gate を得る目的だけの、trivial・無関係・説明だけの保護対象ファイル編集は manipulation とみなし `blocked` とする。')
    expect(checklistDa2).toContain('Human Gate を得る目的だけの trivial・無関係・説明だけの保護対象編集は manipulation として blocked とした')
  })

  it('同じ PR の rule 変更: 既存 authority にも A→B の根拠にもならないが、rule と実装を一体で code-owner 判断に出せる', () => {
    expect(da2Section).toContain('4. このPR自身によるcanonical rule変更を、そのPRのauthority根拠として使用しない（A を B に変える根拠にもしない）。')
    expect(da2Section).toContain('PR は自分の rule 変更を既存の authority として使うことも、A を B に変える根拠にすることもできない。一方で、rule と実装を同じ PR に一体として載せ、code-owner の判断に出すことはできる。')
    expect(humanDecisionSection).toContain('その変更を根拠に自分の scope を正当化しない（既承認の authority として扱わず、A を B に変える根拠にもしない。')
    expect(humanDecisionSection).toContain('ただし rule 変更と実装を同じ PR に一体として含め、PR 全体を A として CODEOWNERS review の判断に委ねることはできる')
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

    // 既承認 rule（base branch の approval_rules.md）が全文、A/B 指示と共に届く（canonical context delivery gap）
    const approvalRules = readFileSync(path.join(REPO_ROOT, 'docs/project_memory/rules/approval_rules.md'), 'utf-8')
    expect(built).toContain('### 承認済み canonical approval rules (base branch)')
    expect(built).toContain(approvalRules.trimEnd())
    expect(built.indexOf('### 承認済み canonical approval rules (base branch)')).toBeLessThan(built.indexOf('**Git Diff**（'))

    // rule は diff より前にあり、prompt は末尾の回答指示まで揃っている
    expect(built.indexOf('### DA trigger (2)')).toBeLessThan(built.indexOf('**Git Diff**（'))
    expect(built).toContain(diff)
    expect(built.trimEnd().endsWith('上記のdiffを確認し、MetaReviewResultのJSON形式で回答してください。')).toBe(true)
  })
})

/**
 * 2026-10-27: Meta Review が定義の無い語で誤分類した2件（PR #419 / #412）の回帰。
 *
 * - #419 の形: 既存の認証付き internal route（Worker allowlist の reconcile route）の応答に、同じ呼び出し元向けの
 *   非機密の項目（continuation id・経過 ms）を足した差分を DA (3)「公開 route」と分類した。canonical の「公開」は
 *   外部ユーザー・地域・市場への公開（specs/22 §1-1）。
 * - #412 の形: 通知の修正であることだけで、型として「Safety boundary の意味の変更」と分類した。正しくは不変条件で判定する:
 *   誤報だけを遅らせ、本当の失敗は base より遅れずに届くなら B、本当の失敗が遅れて届きうるなら A（検知の速さの trade-off）。
 *
 * 結論（B）そのものではなく **B とする前提条件**・反例（A のまま）・fail-closed・他 trigger の優先を固定する
 * （独立レビュー指摘: 結論の文言だけを固定すると、trigger の文字列を残したまま迂回を指示する prompt を通してしまう）。
 * 特定 PR は名指ししない。
 */
describe('Meta Reviewer 判定契約 — DA (3) の「公開」と通知の変更の定義', () => {
  for (const [label, text] of [['prompt.md', prompt], ['checklist.md', checklist]] as const) {
    describe(label, () => {
      it('DA trigger (1)〜(7) の一覧はそのまま残る', () => {
        for (const trigger of [
          '- (1) Goal・事業上の Goal 優先順位',
          '- (2) authority 定義（Approval・Gate policy・`plActionPolicy`・permission・`guards/**`・commitGate）の変更。強化と弱体化を機械判定できない間は fail closed。',
          '- (3) 新しい外部 service・有償依存・公開範囲・公開 route',
          '- (4) 個人データ・保持・削除方針の変更',
          '- (5) 不可逆',
          '- (6) diff 内の secret 検出',
          '- (7) Review verdict の不一致が未解消',
        ]) expect(text).toContain(trigger)
      })

      it('DA (3): internal route の項目追加は「それだけでは」当たらず、B には全前提の確認が要る', () => {
        expect(text).toContain('既存の認証付き internal route の応答に項目を足すという事実だけでは DA (3) に当たらない。DA (3) について B とするのは、次をすべて差分と既存コードから確認できた場合に限る:')
        expect(text).toContain('- 呼び出し元が既存の credential class・既存の allowlist のままである（同じ差分で allowlist・認証・route の公開設定を変えていない）')
        expect(text).toContain('- 追加するデータが既存の data-use / sensitivity の範囲内である（secret・認証情報・個人データを含まない）')
        expect(text).toContain('- proxy・relay・log・telemetry を含め、新しい閲覧先を作らない')
        expect(text).toContain('- 他の DA trigger（特に (2) authority・(4) 個人データ）に当たらない')
        // 無条件の「B である」に戻っていないこと
        expect(text).not.toContain('同じ呼び出し元向けの項目を足す差分は公開範囲の拡大ではなく B である')
      })

      it('DA (3) の反例は A のまま（認証なし route・新しい呼び出し元への開放・allowlist 追加・認証の除去・外部から新しく見えるデータ）', () => {
        expect(text).toContain('- 認証なしで呼べる route、または外部の利用者・client 向けの新しい endpoint を追加する')
        expect(text).toContain('- 既存 route を新しい credential class・外部 client・新しい呼び出し元へ開く（allowlist への追加を含む）、または既存の認証・allowlist の確認を外す')
        expect(text).toContain('- 外部の audience から新しく見えるようになるデータを追加する')
      })

      it('既に外部から呼べる route は、実際に変わる trigger で判定する（呼べることだけでは A にしない）', () => {
        expect(text).toContain('既に外部から呼べる route でも、外部から呼べることだけでは A にしない。追加項目が新しい外部 audience・公開範囲、個人データ・データ利用方針、Product / Policy、authority を変える場合に、該当する trigger で A とする。')
      })

      it('DA (3) は確認不能なら A、漏えいなどの技術的欠陥は Decision Authority と独立に止める', () => {
        expect(text).toContain('差分に含まれ required CI が実行するテストが、これらの前提（例: route が既存の credential でしか呼べないこと）を実際に assert している場合は、確認できたものとして扱ってよい（テストが空振り・無関係なら確認とみなさない）。それ以外で確認できない場合は A とする（fail closed）。')
        expect(text).toContain('secret・個人データの漏えいなどの技術的欠陥は、Decision Authority の判定とは独立に `blocked` / `changes_requested` の対象である。')
      })

      it('通知: approval_rules の根拠は Approval Tuple の範囲だけで、Safety boundary 不変の証明ではない', () => {
        expect(text).toContain('通知（alert・escalation・LINE などの CRITICAL 通知）の変更は、通知の変更という種類だけでは A にしない。')
        expect(text).toContain('これは Approval Tuple の範囲についての根拠であり、Safety boundary が不変であることの証明ではない。')
      })

      it('通知を B とするには、event 集合・severity・受信者（CEO）・配達保証・backstop・実行可否への効果がすべて不変または強化', () => {
        expect(text).toContain('通知の変更を B とするのは、base canonical rule と従来の production の event の意味に対して、次がすべて不変または強化であることを差分と既存コードから確認できた場合に限る:')
        expect(text).toContain('- 通知の対象となる失敗の event の集合と severity の判定')
        expect(text).toContain('- 必要な受信者（CEO を含む）と、要求された配達の保証')
        expect(text).toContain('- 独立した backstop')
        expect(text).toContain('- gate・承認・Job intake など実行可否への効果（通知が実行可否の判定の一部なら、その判定を変えない）')
      })

      it('遅らせる場合は、誤報であること・production で発火する代替経路の有界な配達・本当の失敗が base より遅れないこと・有限の上限と tests による確認を要求する（roadmap 項目は根拠にしない）', () => {
        expect(text).toContain('- 遅らせる対象が正常系の誤報であり、同じ類の本当の失敗は production の経路で実際に発火する経路により、base より遅くない時間で必要な受信者へ届く（本当の失敗が base より遅れて届きうる遅延は、検知の速さと誤報の量の trade-off であり、技術的な修正ではない）')
        expect(text).toContain('- 遅らせた通知にも有限の上限があり（有界でない待ちにしない）、その上限と上の配達を、required CI が実行するこの差分の tests が実際に確かめている。roadmap 項目（base にある項目も過去の PR で AI が追加しうる）・PR 本文・commit message・テスト名は、これらを確認した根拠にしない')
        expect(text).not.toContain('CEO 承認済みの roadmap 項目')
        expect(text).not.toContain('の roadmap 項目（作業 scope を示す文脈であり、承認ではない）が明示的に求める範囲')
      })

      it('通知の反例は A のまま（失敗の類の通知を無くす・条件外の遅延・再分類 / severity 低下・CEO 通知条件 / 受信者の変更・実行可否の判定の変更）', () => {
        expect(text).toContain('- 本当の失敗のある類について、通知を無くす、base より遅れて届きうるようにする、または有界でない待ちにする（Safety boundary の弱体化。`specs/22` §1-2）')
        expect(text).toContain('- base で承認された意味の上で失敗である event の類を、失敗でないと再分類する、または その severity を下げる')
        expect(text).toContain('- CEO へ通知する条件そのもの（`CLAUDE.md`「Escalation Rules」・DA trigger）や必要な受信者を変える')
        expect(text).toContain('- 通知が gate・承認・Job intake など実行可否を決める判定の一部であり、その判定を変える')
      })

      it('通知も確認不能なら A、PR 本文の自己申告だけでは B にしない', () => {
        expect(text).toContain('確認できない場合は A とする（fail closed）。通知の修正であることを PR 本文が主張しているだけでは B にしない。')
      })

      it('PR 自身の canonical / 判定規則の変更で自分を B にしない既存規則は残る', () => {
        expect(prompt).toContain('その変更を根拠に自分の scope を正当化しない')
      })
    })
  }

  it('prompt と checklist の定義は同一文面（片方だけ緩めない）', () => {
    const definitions = (text: string): string => text.slice(
      text.indexOf('DA (3) の「公開範囲・公開 route」は'),
      text.indexOf('通知の修正であることを PR 本文が主張しているだけでは B にしない。'),
    )
    expect(definitions(prompt)).toBe(definitions(checklist))
    expect(definitions(prompt).length).toBeGreaterThan(500)
  })
})
