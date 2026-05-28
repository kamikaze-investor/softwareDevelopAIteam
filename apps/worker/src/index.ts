/**
 * AI Development Team OS — Worker
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 * このファイルはAIが改変してはならない。
 *
 * 役割:
 * - JobQueueからJobを取得
 * - Permission Guardで検証
 * - Docker Sandboxで実行
 * - File Change Guardでdiffを検証
 * - 結果を保存
 */

import { permissionGuard } from './guards/permissionGuard'
import { fileChangeGuard } from './guards/fileChangeGuard'

console.log('Worker starting...')

// Job polling loop (Phase 1で実装)
async function pollJobs() {
  console.log('Polling for jobs...')
  // TODO: task-009で実装
}

pollJobs()
