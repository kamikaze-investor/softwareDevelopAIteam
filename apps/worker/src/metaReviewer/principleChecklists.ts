import type { PrincipleSelection, PrincipleSlug } from '@ai-team/shared/src/engineeringPrinciples.js'

/**
 * 原則が自分の review guidance として持つ checklist（`docs/meta_reviewer/checklists/` 配下）。
 *
 * **checklist を「いつ」載せるかはここで決めない。** 決めるのは原則の選択
 * （`FOCUS_PRINCIPLE_SLUGS` → `selectPrinciples()`）だけで、ここはその結果を guidance の
 * 置き場所へ写すだけである。focus や path から checklist を別に選ぶ対応表を持つと、
 * 原則の routing と二重正本になる。
 */
const PRINCIPLE_CHECKLIST_FILES: Partial<Record<PrincipleSlug, string>> = {
  'canonical-domain-meaning': 'semantic_integrity.md',
}

/** 選ばれた原則が持つ checklist file 名。選択順を保ち、重複を除く。 */
export function principleChecklistFiles(selection: readonly PrincipleSelection[]): string[] {
  const files = selection.flatMap((item) => {
    const file = PRINCIPLE_CHECKLIST_FILES[item.slug]
    return file === undefined ? [] : [file]
  })
  return [...new Set(files)]
}
