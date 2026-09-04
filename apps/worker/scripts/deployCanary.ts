import { reviewWithProviderFallback, MetaReviewProviderError } from '../src/metaReviewer/metaReviewFallbackRouter.js'
import { createReviewerAdapter, type ReviewerRequest } from '../src/approvalLevel/reviewerAdapter.js'

/**
 * Production deploy canary — one bounded, read-only check that the two real provider
 * paths used by Whole-Roadmap / Task Design Review actually work after a restart:
 *
 *  1. Primary review provider (Gemini API → Gemini CLI → Copilot CLI), via the same
 *     reviewWithProviderFallback() used by autoReview.ts. quota/transient failures are
 *     expected to fall back to Copilot; auth_or_config/unknown fail closed (no silent
 *     Copilot substitution for those, matching metaReviewFallbackRouter.ts's own policy).
 *  2. Critical-load Independent Review provider (Codex), via the same
 *     CodexReviewerAdapter.review() used by runIndependentReview(). Specifically checks
 *     that the response is NOT the parse-failure signature
 *     (summary === 'レビュー応答のパースに失敗しました', confidence === 0) that PR #77
 *     fixed — this is what actually proves the fix is live, not just present in the diff.
 *
 * No DB access, no HTTP server, no Task/Project rows created. Safe to run any number of
 * times. Exits non-zero (fail-closed) if either provider path is unavailable.
 */

const RESULT_PREFIX = 'DEPLOY_CANARY_RESULT'

function reportPass(check: string, detail: string): void {
  console.info(`${RESULT_PREFIX}=PASS check=${check} ${detail}`)
}

function reportFail(check: string, reason: string): void {
  console.error(`${RESULT_PREFIX}=FAIL check=${check} reason=${reason}`)
}

export async function runGeminiCanary(): Promise<boolean> {
  try {
    const { providerUsed } = await reviewWithProviderFallback(
      'This is a production deploy canary check, not a real review. Reply with exactly: {"ok":true}',
      { featureName: 'production-deploy-canary', retryTransient: true, cliModel: 'gemini-3.8-flash', cliEffort: 'medium' },
    )
    reportPass('gemini_provider_path', `providerUsed=${providerUsed}`)
    return true
  } catch (err) {
    if (err instanceof MetaReviewProviderError) {
      reportFail('gemini_provider_path', `failureClass=${err.failureClass}`)
    } else {
      reportFail('gemini_provider_path', 'unexpected_error')
    }
    return false
  }
}

async function runCodexIndependentReviewCanary(): Promise<boolean> {
  const req: ReviewerRequest = {
    jobId: 'deploy-canary',
    reviewKind: 'task',
    subjectId: 'deploy-canary',
    taskId: 'deploy-canary',
    implementerProvider: 'claude_code',
    reviewerProvider: 'codex',
    phase: 'post',
    diffText: [
      'diff --git a/canary.txt b/canary.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/canary.txt',
      '@@ -0,0 +1 @@',
      '+production deploy canary check',
    ].join('\n'),
    purposeSummary: 'Production deploy canary: confirm the independent Codex reviewer path '
      + '(adapter.ts --output-last-message capture + CodexReviewerAdapter.review() parsedOutput '
      + 'preference, PR #77) returns a real structured verdict instead of the pre-fix parse-failure.',
    targetFiles: ['canary.txt'],
  }

  const result = await createReviewerAdapter('codex').review(req)
  const isParseFailure = result.summary === 'レビュー応答のパースに失敗しました' && result.confidence === 0
  const isInvocationFailure = result.summary.startsWith('レビューAI呼び出しに失敗しました')

  if (isParseFailure) {
    reportFail('codex_independent_review', 'parse_failure_signature_still_present')
    return false
  }
  if (isInvocationFailure) {
    reportFail('codex_independent_review', 'cli_invocation_failed')
    return false
  }

  reportPass('codex_independent_review', `verdict=${result.verdict} confidence=${result.confidence}`)
  return true
}

async function main(): Promise<void> {
  const geminiOk = await runGeminiCanary()
  const codexOk = await runCodexIndependentReviewCanary()

  if (geminiOk && codexOk) {
    console.info(`${RESULT_PREFIX}=PASS check=all`)
    process.exitCode = 0
  } else {
    console.error(`${RESULT_PREFIX}=FAIL check=all`)
    process.exitCode = 1
  }
}

if (require.main === module) {
  void main()
}
