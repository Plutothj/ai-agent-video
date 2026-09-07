/**
 * 修正导入音色的 voiceId：s1_xxx → DescribeVoices 返回的英文 VoiceId
 *
 * DescribeVoices 返回的 VoiceId（如 "Chinese (Mandarin)_Reliable_Executive"）
 * 才是 TextToSpeechAsync 接受的格式。旧系统 voice 表存的 s1_xxx 只是音频文件名。
 *
 * 匹配策略：按 voice_name（中文名）= DescribeVoices.Name 精确匹配。
 */
import { createConnection } from 'mysql2/promise'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VOICES_MAP_PATH = join(__dirname, '../../voices-map.json')

async function main() {
  const voicesMap = JSON.parse(readFileSync(VOICES_MAP_PATH, 'utf8'))
  console.log(`[map] DescribeVoices entries: ${voicesMap.length}`)

  const tgt = await createConnection({
    host: '127.0.0.1', port: 13306,
    user: 'root', password: 'waoowaoo123', database: 'waoowaoo',
  })

  const [user] = await tgt.query('SELECT id FROM user WHERE name=? LIMIT 1', ['pluto'])
  const userId = user[0].id

  const [imported] = await tgt.query(
    'SELECT id, name, voiceId FROM global_voices WHERE userId=? AND voiceType=?',
    [userId, 'tencent-vod'],
  )
  console.log(`[db] imported tencent-vod voices: ${imported.length}`)

  // name → VoiceId
  const nameToVid = new Map()
  for (const v of voicesMap) nameToVid.set(v.name, v.vid)

  let matched = 0, updated = 0, unmatched = 0
  const unmatchedNames = []
  for (const gv of imported) {
    const correctVid = nameToVid.get(gv.name)
    if (correctVid) {
      matched++
      if (correctVid !== gv.voiceId) {
        await tgt.query('UPDATE global_voices SET voiceId=? WHERE id=?', [correctVid, gv.id])
        updated++
      }
    } else {
      unmatched++
      if (unmatchedNames.length < 15) unmatchedNames.push(gv.name)
    }
  }

  console.log(`[result] matched: ${matched}, updated: ${updated}, unmatched: ${unmatched}`)
  if (unmatchedNames.length) console.log(`[unmatched samples] ${unmatchedNames.join(', ')}`)

  await tgt.end()
}

main().catch((e) => { console.error('[error]', e.message); process.exit(1) })
