import fs from 'node:fs'
const p = 'apps/worker/src/index.ts'
const raw = fs.readFileSync(p, 'utf-8')
const nl = raw.includes('\r\n') ? '\r\n' : '\n'
let s = raw.replace(/\r\n/g, '\n')

// inline the POST with the established pattern (no new helper)
const from = `      console.log(\`[Worker] Job \${requested.id} の workspace を観測し、abort cleanup 結果を報告します\`)
      const response = await postJson(
        \`/api/jobs/\${encodeURIComponent(requested.id)}/abort-cleanup-result\`,
        { observation: observed.observation },
      )
      if (!response) {
        console.warn(\`[Worker] Job \${requested.id} の abort cleanup 結果を報告できませんでした\`)
      }
      return true`
const to = `      console.log(\`[Worker] Job \${requested.id} の workspace を観測し、abort cleanup 結果を報告します\`)
      try {
        const response = await fetch(
          \`\${API_BASE}/api/jobs/\${encodeURIComponent(requested.id)}/abort-cleanup-result\`,
          {
            method: 'POST',
            headers: { ...buildApiAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ observation: observed.observation }),
          },
        )
        if (!response.ok) {
          // 不一致なら API が fail-closed で拒否する。所有権は保持されたままで、これは正常な結果。
          console.warn(
            \`[Worker] Job \${requested.id} の abort cleanup は成立しませんでした: HTTP \${response.status}\`,
          )
        }
      } catch (err: unknown) {
        console.warn(\`[Worker] abort cleanup 報告エラー: \${formatUnknownError(err)}\`)
      }
      return true`
if (s.split(from).length - 1 !== 1) throw new Error('post block not unique')
s = s.replace(from, to)

// import observeWorkspace
const impFrom = `import {
  revertBlockedJobChanges,`
if (s.split(impFrom).length - 1 !== 1) throw new Error('import anchor not unique')
s = s.replace(impFrom, `import { observeWorkspace } from './workspaceVerification.js'
import {
  revertBlockedJobChanges,`)

fs.writeFileSync(p, s.replace(/\n/g, nl), 'utf-8')
console.log('seam wired to existing helpers')
