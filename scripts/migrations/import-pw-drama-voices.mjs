/**
 * 一次性迁移：pw_drama.voice（腾讯云音色列表）→ waoowaoo.global_voices
 *
 * 源：192.168.1.56/pw_drama.voice（is_deleted=0，voice_id 为腾讯云 TextToSpeech 的 VoiceId）
 * 目标：本机 docker waoowaoo.global_voices，voiceType 标记为 'tencent-vod'，
 *       供配音阶段 VoicePickerDialog 选择并绑定到发言人/角色。
 *
 * 幂等：按 (userId, voiceId) 去重，重复执行只补缺。
 * 用法：node scripts/migrations/import-pw-drama-voices.mjs [--dry-run]
 */
import { createConnection } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const DRY_RUN = process.argv.includes('--dry-run')

const SOURCE = {
  host: '192.168.1.56',
  port: 3306,
  user: 'root',
  database: 'pw_drama',
}
const TARGET = {
  host: '127.0.0.1',
  port: 13306,
  user: 'root',
  password: 'waoowaoo123',
  database: 'waoowaoo',
}

function readSourcePassword() {
  const dbxDb = process.env.APPDATA
    ? `${process.env.APPDATA.replace(/\\/g, '/')}/com.dbx.app/dbx.db`
    : null
  if (!dbxDb) throw new Error('APPDATA 未设置，无法读取 DBX 凭据；请设置环境变量 PW_DRAMA_PASSWORD')
  const db = new DatabaseSync(dbxDb, { readOnly: true })
  const row = db.prepare(
    "SELECT secret FROM connection_secrets WHERE key = 'password' AND connection_id = (SELECT id FROM connections WHERE json_extract(config_json, '$.host') = '192.168.1.56' LIMIT 1)"
  ).get()
  if (!row) throw new Error('DBX 中未找到 192.168.1.56 连接的密码')
  return row.secret
}

function mapGender(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === '0' || v === 'male') return 'male'
  if (v === '1' || v === 'female') return 'female'
  return null
}

async function main() {
  SOURCE.password = process.env.PW_DRAMA_PASSWORD || readSourcePassword()

  const src = await createConnection(SOURCE)
  const [voices] = await src.query(
    `SELECT voice_id, voice_name, language, gender, description, tags, scene, audio_url
     FROM voice WHERE is_deleted = 0 ORDER BY index_no`
  )
  await src.end()
  console.log(`[source] pw_drama.voice 有效行: ${voices.length}`)

  const tgt = await createConnection(TARGET)
  const [users] = await tgt.query("SELECT id FROM user WHERE name = 'pluto' OR email IS NULL ORDER BY createdAt LIMIT 1")
  if (users.length !== 1) throw new Error(`目标用户解析失败，命中 ${users.length} 个`)
  const userId = users[0].id
  console.log(`[target] 归属用户: ${userId}`)

  const [existing] = await tgt.query('SELECT voiceId FROM global_voices WHERE userId = ? AND voiceType = ?', [userId, 'tencent-vod'])
  const existingIds = new Set(existing.map((r) => r.voiceId))

  let inserted = 0
  let skipped = 0
  for (const v of voices) {
    const voiceId = String(v.voice_id || '').trim()
    if (!voiceId) { skipped++; continue }
    if (existingIds.has(voiceId)) { skipped++; continue }

    const descParts = [v.description, v.tags && `标签：${v.tags}`, v.scene && `场景：${v.scene}`].filter(Boolean)
    const row = {
      id: randomUUID(),
      userId,
      folderId: null,
      name: String(v.voice_name || voiceId).slice(0, 100),
      description: descParts.join('；') || null,
      voiceId,
      voiceType: 'tencent-vod',
      customVoiceUrl: String(v.audio_url || '').slice(0, 500) || null,
      voicePrompt: null,
      gender: mapGender(v.gender),
      language: String(v.language || 'zh').slice(0, 20),
    }
    if (!DRY_RUN) {
      await tgt.execute(
        `INSERT INTO global_voices (id, userId, folderId, name, description, voiceId, voiceType, customVoiceUrl, voicePrompt, gender, language, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
        [row.id, row.userId, row.folderId, row.name, row.description, row.voiceId, row.voiceType, row.customVoiceUrl, row.voicePrompt, row.gender, row.language]
      )
    }
    inserted++
  }

  const [count] = await tgt.query('SELECT COUNT(*) n FROM global_voices WHERE userId = ? AND voiceType = ?', [userId, 'tencent-vod'])
  await tgt.end()
  console.log(`[${DRY_RUN ? 'dry-run' : 'done'}] 新增 ${inserted}，跳过 ${skipped}，目标库现有 tencent-vod 音色 ${count[0].n}`)
}

main().catch((error) => {
  console.error('[import] 失败:', error)
  process.exit(1)
})
