/**
 * 一次性迁移脚本：把旧本地 MinIO 中的对象搬到 TOS（业务 key 不变）。
 *
 * 背景：存储从本地 MinIO 切换为火山引擎 TOS（公网域名供腾讯云 AIGC 等外部服务拉取），
 * 切换前生成的角色/场景/分镜图仍存于 MinIO，公网直链 404。本脚本将对象原样转存，
 * 数据库中的引用键无需任何改动。
 *
 * 用法（在 app 容器内执行，TOS 环境变量由容器注入）：
 *   docker exec -e MIGRATE_MINIO_ENDPOINT=http://waoowaoo-minio:9000 \
 *     -e MIGRATE_MINIO_BUCKET=waoowaoo waoowaoo-app npx tsx scripts/migrate-minio-to-tos.ts
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { createScopedLogger } from '@/lib/logging/core'
import { uploadObject } from '@/lib/storage'

const logger = createScopedLogger({ module: 'scripts.migrate-minio-to-tos' })

const endpoint = process.env.MIGRATE_MINIO_ENDPOINT || 'http://waoowaoo-minio:9000'
const bucket = process.env.MIGRATE_MINIO_BUCKET || 'waoowaoo'
const accessKeyId = process.env.MIGRATE_MINIO_ACCESS_KEY || 'minioadmin'
const secretAccessKey = process.env.MIGRATE_MINIO_SECRET_KEY || 'minioadmin'
// tmp/ 前缀是一次性转存的临时资源，无需迁移
const skipPrefixes = ['tmp/']
const CONCURRENCY = 3

async function listAllKeys(s3: S3Client): Promise<string[]> {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
        const res = await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
        }))
        for (const item of res.Contents || []) {
            if (item.Key) keys.push(item.Key)
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (continuationToken)
    return keys
}

async function main() {
    const s3 = new S3Client({
        region: process.env.MIGRATE_MINIO_REGION || 'us-east-1',
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
    })

    const allKeys = await listAllKeys(s3)
    const targets = allKeys.filter((key) => !skipPrefixes.some((prefix) => key.startsWith(prefix)))
    logger.info({
        action: 'migrate.scan',
        message: 'scan finished',
        details: { endpoint, bucket, total: allKeys.length, targets: targets.length },
    })

    if (targets.length === 0) {
        logger.info({ action: 'migrate.done', message: 'nothing to migrate' })
        return
    }

    let ok = 0
    let failed = 0
    const failures: Array<{ key: string, error: string }> = []
    let cursor = 0

    async function worker() {
        while (cursor < targets.length) {
            const key = targets[cursor]
            cursor += 1
            try {
                const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
                const bytes = await res.Body?.transformToByteArray()
                if (!bytes) throw new Error('empty object body')
                await uploadObject(Buffer.from(bytes), key)
                ok += 1
                if (ok % 10 === 0) {
                    logger.info({ action: 'migrate.progress', message: 'progress', details: { ok, failed, total: targets.length } })
                }
            } catch (error) {
                failed += 1
                failures.push({ key, error: error instanceof Error ? error.message : String(error) })
                logger.error({
                    action: 'migrate.object_failed',
                    message: 'object migration failed',
                    details: { key },
                    error: { message: error instanceof Error ? error.message : String(error) },
                })
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()))

    logger.info({
        action: 'migrate.summary',
        message: 'migration finished',
        details: { total: targets.length, ok, failed, failures: failures.slice(0, 20) },
    })
    if (failed > 0) {
        process.exitCode = 1
    }
}

main().catch((error) => {
    logger.error({
        action: 'migrate.fatal',
        message: 'migration crashed',
        error: { message: error instanceof Error ? error.message : String(error) },
    })
    process.exit(1)
})
