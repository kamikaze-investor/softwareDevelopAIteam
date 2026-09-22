/**
 * resume actor の判定と記録（pure な部分）。
 *
 * ここで固定するのは 1 点だけである:
 * **`admin` credential だけが `human` になり、それ以外は全部 human にならない。**
 */

import { describe, expect, it } from 'vitest'
import type { AuditLogEntry } from '@ai-team/shared'
import type { CredentialClass } from '../auth/credentialClass'
import {
  RESUME_ACTOR_OPERATION,
  resumeActorClassForCredential,
  resumeActorClassFromAudit,
  resumeEvidenceForCredential,
  recordRepairGeneration,
  recordResumeActor,
} from './resumeActor'

function auditEntry(operation: string, result: string): AuditLogEntry {
  return {
    id: `audit-${operation}-${result}`,
    actor: 'api',
    operation,
    entityType: 'job',
    entityId: 'job-1',
    result,
    createdAt: '2026-09-22T00:00:00.000Z',
  }
}

describe('[20] resumeActorClassForCredential — admin 以外は human にならない', () => {
  it('admin credential だけが human', () => {
    expect(resumeActorClassForCredential('admin')).toBe('human')
  })

  it('worker / actions_readonly / legacy / 未認証 はどれも human ではない', () => {
    const nonHuman: (CredentialClass | undefined)[] = ['worker', 'actions_readonly', 'legacy', undefined]
    for (const credentialClass of nonHuman) {
      expect(resumeActorClassForCredential(credentialClass)).not.toBe('human')
    }
  })

  it('legacy 単一 token は unknown（人と Worker を区別する材料が無い）', () => {
    expect(resumeActorClassForCredential('legacy')).toBe('unknown')
    expect(resumeEvidenceForCredential('legacy')).toBe('legacy_shared_credential')
  })

  it('認証 hook を通っていない request も unknown', () => {
    expect(resumeActorClassForCredential(undefined)).toBe('unknown')
    expect(resumeEvidenceForCredential(undefined)).toBe('no_credential')
  })

  it('根拠の種別名は credential 種別と 1 対 1 で対応する', () => {
    expect(resumeEvidenceForCredential('admin')).toBe('admin_credential')
    expect(resumeEvidenceForCredential('worker')).toBe('worker_credential')
    expect(resumeEvidenceForCredential('actions_readonly')).toBe('actions_readonly_credential')
  })
})

describe('[12][13] resumeActorClassFromAudit — 記録が無い / 矛盾するなら human にしない', () => {
  it('記録が 1 件だけなら、その値を返す（human は根拠の種別も揃っている場合のみ）', () => {
    expect(resumeActorClassFromAudit([{
      ...auditEntry(RESUME_ACTOR_OPERATION, 'human'),
      detail: 'task_id=t1 resume_actor=human authorization_evidence=admin_credential',
    }])).toBe('human')
    expect(resumeActorClassFromAudit([auditEntry(RESUME_ACTOR_OPERATION, 'ai')])).toBe('ai')
  })

  it('記録が 1 件も無ければ unknown', () => {
    expect(resumeActorClassFromAudit([])).toBe('unknown')
  })

  it('別 operation の行しか無ければ unknown', () => {
    expect(resumeActorClassFromAudit([auditEntry('job_created', 'human')])).toBe('unknown')
  })

  it('human と ai が両方記録されていたら unknown（矛盾は human へ倒さない）', () => {
    const entries = [
      auditEntry(RESUME_ACTOR_OPERATION, 'human'),
      auditEntry(RESUME_ACTOR_OPERATION, 'ai'),
    ]
    expect(resumeActorClassFromAudit(entries)).toBe('unknown')
  })

  it('知らない値が記録されていたら unknown', () => {
    expect(resumeActorClassFromAudit([auditEntry(RESUME_ACTOR_OPERATION, 'ceo')])).toBe('unknown')
  })
})

describe('[4][21] human は「根拠の種別」まで揃って初めて成立する（独立レビュー指摘）', () => {
  function humanRow(detail: string | undefined): AuditLogEntry {
    return { ...auditEntry(RESUME_ACTOR_OPERATION, 'human'), detail }
  }

  it('admin credential を根拠にした human 行だけを human と読む', () => {
    expect(resumeActorClassFromAudit([
      humanRow('task_id=t1 resume_actor=human authorization_evidence=admin_credential'),
    ])).toBe('human')
  })

  it('根拠の書かれていない human 行は unknown', () => {
    expect(resumeActorClassFromAudit([humanRow(undefined)])).toBe('unknown')
    expect(resumeActorClassFromAudit([humanRow('task_id=t1 resume_actor=human')])).toBe('unknown')
  })

  it('admin 以外の根拠が書かれた human 行は unknown', () => {
    for (const evidence of ['legacy_shared_credential', 'worker_credential', 'no_credential', 'in_process_pl']) {
      expect(resumeActorClassFromAudit([
        humanRow(`task_id=t1 resume_actor=human authorization_evidence=${evidence}`),
      ])).toBe('unknown')
    }
  })

  it('紛らわしい接尾辞（admin_credential_x）では成立しない', () => {
    expect(resumeActorClassFromAudit([
      humanRow('task_id=t1 resume_actor=human authorization_evidence=admin_credential_x'),
    ])).toBe('unknown')
  })

  it('human 行が 2 件あり片方に根拠が無ければ unknown', () => {
    expect(resumeActorClassFromAudit([
      humanRow('task_id=t1 resume_actor=human authorization_evidence=admin_credential'),
      humanRow('task_id=t1 resume_actor=human'),
    ])).toBe('unknown')
  })

  it('ai 行は根拠の種別に関わらず ai のまま（何の権限も与えないため）', () => {
    expect(resumeActorClassFromAudit([
      { ...auditEntry(RESUME_ACTOR_OPERATION, 'ai'), detail: 'task_id=t1 resume_actor=ai authorization_evidence=in_process_pl' },
    ])).toBe('ai')
  })
})

describe('記録の失敗が呼び出し側を失敗させない', () => {
  it('auditLog.record が例外を投げても recordResumeActor は投げ返さない', () => {
    const storage = {
      auditLog: {
        record: () => { throw new Error('disk is full') },
      },
    } as unknown as Parameters<typeof recordResumeActor>[0]

    expect(() => recordResumeActor(storage, {
      jobId: 'job-1', taskId: 'task-1', actorClass: 'human', evidence: 'admin_credential',
    })).not.toThrow()
  })

  it('auditLog.record が例外を投げても recordRepairGeneration は投げ返さない', () => {
    const storage = {
      auditLog: {
        record: () => { throw new Error('disk is full') },
      },
    } as unknown as Parameters<typeof recordRepairGeneration>[0]

    expect(() => recordRepairGeneration(storage, {
      jobId: 'job-1', taskId: 'task-1', generationRoot: 'job-0', ancestryDepth: 0,
      budgetReset: false, resetReason: 'same_generation',
    })).not.toThrow()
  })
})
