/**
 * Roadmap item の identity と Task の identity を分ける、小さな純粋関数群。
 *
 * **なぜ分けるのか（CEO 判断・2026-09-17）**: 一度実行した Roadmap 項目に残作業がある場合だけ、
 * bounded な follow-up Task を作れるようにした。follow-up は **別の Task identity** として作る。
 * こうすると `ALREADY_EXECUTED`（同一 Task identity の二重実行を拒否する既存防御）を
 * **弱めずに**残作業を進められる。保証は
 * 「この Roadmap item は一度でも実行されたら永久に禁止」から
 * 「**同一 Task identity の二重実行は禁止**」へ精緻化される。
 *
 * ```text
 * baseRoadmapId   … 正式な Roadmap ledger item の id。
 *                   ledger 参照・state 判定・alignment・残作業判定はすべてこちらを使う。
 * roadmapTaskKey  … 個別 Task の identity。通常 Task は baseRoadmapId と同一で、
 *                   follow-up だけ `#<sequence>` を持つ。
 * ```
 *
 * 文字列 split を各所へばら撒かないため、判定はこの1ファイルへ閉じる。
 * **新しい Registry も schema も持たない。** 既存の `tasks.roadmap_task_key` 1列だけで表現する
 * （UNIQUE 制約 `ux_tasks_project_roadmap_task_key` がそのまま identity の一意性を担保する）。
 */

/**
 * 1 Roadmap item あたりの follow-up 上限。
 *
 * **通常作業を縛る数字ではない。** 大きな項目が複数 Task に分かれること自体は正常である
 * （API → Worker → Mobile → E2E のように別の残作業を順に消化する形）。
 * これは「同じ仕事を繰り返している」ことに気付くための**最後の非常ブレーキ**であり、
 * 到達前に同一 scope / 進捗なし / 同一失敗の反復を検出して早期停止することが本来の防御である。
 */
export const MAX_FOLLOW_UPS_PER_ROADMAP_ITEM = 10

/** 初回 Task は suffix を持たない。follow-up の sequence はここから始まる。 */
const FIRST_FOLLOW_UP_SEQUENCE = 2

/**
 * `<base>#<sequence>`。sequence は十進数のみ。
 *
 * 末尾一致にしているのは、ledger id 自体が `#` を含み得るためである
 * （parser の `roadmap:id` は空白以外を許す）。base 側は貪欲に取り、最後の `#<digits>` だけを
 * sequence と解釈する。
 */
const FOLLOW_UP_KEY_PATTERN = /^(.+)#(\d+)$/

/**
 * Task identity から、それが属する Roadmap ledger item の id を返す。
 *
 * 通常 Task ではそのまま同じ値が返る。**ledger を引くときは必ずこれを通すこと。**
 */
export function getBaseRoadmapId(roadmapTaskKey: string): string {
  const match = FOLLOW_UP_KEY_PATTERN.exec(roadmapTaskKey)
  return match ? (match[1] as string) : roadmapTaskKey
}

/** その Task identity が follow-up のものか。 */
export function isFollowUpTaskKey(roadmapTaskKey: string): boolean {
  return FOLLOW_UP_KEY_PATTERN.test(roadmapTaskKey)
}

/**
 * follow-up の sequence。通常 Task（suffix 無し）は `undefined`。
 *
 * 初回 Task を 1 と数えるため、follow-up は 2 から始まる。
 */
export function getFollowUpSequence(roadmapTaskKey: string): number | undefined {
  const match = FOLLOW_UP_KEY_PATTERN.exec(roadmapTaskKey)
  if (!match) return undefined
  return Number.parseInt(match[2] as string, 10)
}

export type CreateFollowUpTaskKeyResult =
  | { ok: true; roadmapTaskKey: string; sequence: number; followUpCount: number }
  | { ok: false; reason: string; followUpCount: number }

/**
 * follow-up の Task identity を**サーバ側で決める**。
 *
 * **caller に key を入力させてはならない。** sequence を飛ばす・偽造する・既存 Task の key を
 * 名乗る、のいずれもできないようにするため、既存 key の集合からのみ次の値を導出する。
 *
 * 衝突を避けるため `件数 + 1` ではなく **既存 sequence の最大値 + 1** を使う。
 * 途中の Task が消えても既存 key と衝突しない。
 *
 * @param baseRoadmapId   採用元 Roadmap ledger item の id
 * @param existingTaskKeys 同一 Project に実在する Task の `roadmapTaskKey` 全件
 */
export function createFollowUpTaskKey(
  baseRoadmapId: string,
  existingTaskKeys: readonly string[],
): CreateFollowUpTaskKeyResult {
  // base 自体が `#<digits>` で終わると base と follow-up の区別が付かなくなる。
  // 実在の ledger id は kebab-case だが、曖昧なまま identity を作らない。
  if (FOLLOW_UP_KEY_PATTERN.test(baseRoadmapId)) {
    return {
      ok: false,
      followUpCount: 0,
      reason:
        `roadmap id "${baseRoadmapId}" ends with a follow-up style suffix; ` +
        'a base roadmap id must not look like a follow-up task key',
    }
  }

  const siblingSequences = existingTaskKeys
    .filter((key) => getBaseRoadmapId(key) === baseRoadmapId)
    .map((key) => getFollowUpSequence(key))
    .filter((sequence): sequence is number => sequence !== undefined)

  const followUpCount = siblingSequences.length
  if (followUpCount >= MAX_FOLLOW_UPS_PER_ROADMAP_ITEM) {
    return {
      ok: false,
      followUpCount,
      reason:
        `roadmap item "${baseRoadmapId}" already has ${followUpCount} follow-up task(s), ` +
        `the maximum is ${MAX_FOLLOW_UPS_PER_ROADMAP_ITEM}; ` +
        'diagnose roadmap granularity, remaining-work detection or duplicate execution instead of adding another',
    }
  }

  const sequence = siblingSequences.length === 0
    ? FIRST_FOLLOW_UP_SEQUENCE
    : Math.max(...siblingSequences) + 1

  return {
    ok: true,
    roadmapTaskKey: `${baseRoadmapId}#${sequence}`,
    sequence,
    followUpCount,
  }
}
