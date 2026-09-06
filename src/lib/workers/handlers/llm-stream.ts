import type { Job } from 'bullmq'
import { type InternalLLMStreamCallbacks } from '@/lib/llm-observe/internal-stream-context'
import type { LLMStreamKind } from '@/lib/llm-observe/types'
import { TaskTerminatedError } from '@/lib/task/errors'
import { isTaskActive } from '@/lib/task/service'
import { reportTaskProgress, reportTaskStreamChunk } from '@/lib/workers/shared'
import type { TaskJobData } from '@/lib/task/types'
import { assertTaskActive } from '@/lib/workers/utils'

export type WorkerLLMStreamContext = {
  streamRunId: string
  nextSeqByStepLane: Record<string, number>
}

export type WorkerInternalLLMStreamCallbacks = InternalLLMStreamCallbacks & {
  flush: () => Promise<void>
}

export type WorkerLLMActiveController = {
  assertActive?: (stage: string) => Promise<void>
  isActive?: () => Promise<boolean>
}

export function createWorkerLLMStreamContext(job: Job<TaskJobData>, label = 'worker'): WorkerLLMStreamContext {
  return {
    streamRunId: `run:${job.data.taskId}:${label}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    nextSeqByStepLane: {},
  }
}

function nextWorkerStreamSeq(streamContext: WorkerLLMStreamContext, stepId: string | null, lane: string) {
  const key = `${stepId || '__default'}|${lane || 'main'}`
  const current = streamContext.nextSeqByStepLane[key] || 1
  streamContext.nextSeqByStepLane[key] = current + 1
  return current
}

export function createWorkerLLMStreamCallbacks(
  job: Job<TaskJobData>,
  streamContext: WorkerLLMStreamContext,
  activeController?: WorkerLLMActiveController,
): WorkerInternalLLMStreamCallbacks {
  // 流式块微批量：模型 ~150 token/s 时每个 delta 逐条写库（活性检查+双表写入）会把
  // 串行队列吞吐压到每秒十几块，前端轮询只能看到涓涓细流。缓冲后按时间/体积合并落库。
  const flushIntervalMs = 400
  const maxBufferChars = 4000
  const activeProbeIntervalMs = 600
  let publishQueue: Promise<void> = Promise.resolve()
  let terminatedError: TaskTerminatedError | null = null
  let checkingActive = false
  let lastActiveProbeAt = 0
  type PendingChunk = {
    kind: LLMStreamKind
    lane: string
    text: string
    stepId: string | null
    stepAttempt: number | null
    stepTitle: string | null
    stepIndex: number | null
    stepTotal: number | null
  }
  const pendingChunks = new Map<string, PendingChunk>()
  let chunkFlushTimer: ReturnType<typeof setTimeout> | null = null

  const markTerminated = (stage: string) => {
    if (terminatedError) return
    terminatedError = new TaskTerminatedError(
      job.data.taskId,
      `Task terminated during ${stage}`,
    )
  }

  const ensureActiveOrThrow = (stage: string) => {
    void stage
    if (terminatedError) throw terminatedError
  }

  const assertActive = async (stage: string) => {
    if (activeController?.assertActive) {
      await activeController.assertActive(stage)
      return
    }
    await assertTaskActive(job, stage)
  }

  const probeActive = async () => {
    if (activeController?.isActive) {
      return await activeController.isActive()
    }
    return await isTaskActive(job.data.taskId)
  }

  const scheduleActiveProbe = () => {
    if (terminatedError || checkingActive) return
    const now = Date.now()
    if (now - lastActiveProbeAt < activeProbeIntervalMs) return
    checkingActive = true
    lastActiveProbeAt = now
    void probeActive()
      .then((active) => {
        if (!active) {
          markTerminated('worker_llm_stream_probe')
        }
      })
      .finally(() => {
        checkingActive = false
      })
  }

  const enqueue = (stage: string, work: () => Promise<void>) => {
    ensureActiveOrThrow(stage)
    scheduleActiveProbe()
    publishQueue = publishQueue
      .catch(() => undefined)
      .then(async () => {
        ensureActiveOrThrow(stage)
        await assertActive(stage)
        await work()
      })
      .catch((error) => {
        if (error instanceof TaskTerminatedError) {
          markTerminated(stage)
          return
        }
        throw error
      })
  }

  const flushPendingChunks = () => {
    if (chunkFlushTimer) {
      clearTimeout(chunkFlushTimer)
      chunkFlushTimer = null
    }
    if (pendingChunks.size === 0) return
    const entries = [...pendingChunks.values()]
    pendingChunks.clear()
    enqueue('worker_llm_stream', async () => {
      for (const entry of entries) {
        await reportTaskStreamChunk(
          job,
          {
            kind: entry.kind,
            delta: entry.text,
            seq: nextWorkerStreamSeq(streamContext, entry.stepId, entry.lane),
            lane: entry.lane,
          },
          {
            stage: 'worker_llm_stream',
            stageLabel: 'progress.runtime.stage.llmStreaming',
            displayMode: 'detail',
            done: false,
            message: entry.kind === 'reasoning' ? 'progress.runtime.llm.reasoning' : 'progress.runtime.llm.output',
            streamRunId: streamContext.streamRunId,
            ...(entry.stepId ? { stepId: entry.stepId } : {}),
            ...(entry.stepAttempt ? { stepAttempt: entry.stepAttempt } : {}),
            ...(entry.stepTitle ? { stepTitle: entry.stepTitle } : {}),
            ...(entry.stepIndex ? { stepIndex: entry.stepIndex } : {}),
            ...(entry.stepTotal ? { stepTotal: entry.stepTotal } : {}),
          },
        )
      }
    })
  }

  const scheduleChunkFlush = () => {
    for (const entry of pendingChunks.values()) {
      if (entry.text.length >= maxBufferChars) {
        flushPendingChunks()
        return
      }
    }
    if (chunkFlushTimer) return
    chunkFlushTimer = setTimeout(() => {
      chunkFlushTimer = null
      flushPendingChunks()
    }, flushIntervalMs)
  }

  return {
    onStage: ({ stage, provider, step }) => {
      ensureActiveOrThrow(`worker_llm_stage:${stage}`)
      scheduleActiveProbe()
      const stageLabel =
        stage === 'submit'
          ? 'progress.runtime.stage.llmSubmit'
          : stage === 'streaming'
            ? 'progress.runtime.stage.llmStreaming'
            : stage === 'fallback'
              ? 'progress.runtime.stage.llmFallbackNonStream'
              : 'progress.runtime.stage.llmCompleted'
      const stageKey = `worker_llm_${stage}`
      const stepId = typeof step?.id === 'string' && step.id.trim() ? step.id.trim() : null
      const stepAttempt =
        typeof step?.attempt === 'number' && Number.isFinite(step.attempt)
          ? Math.max(1, Math.floor(step.attempt))
          : null
      const stepTitle = typeof step?.title === 'string' && step.title.trim() ? step.title.trim() : null
      const stepIndex =
        typeof step?.index === 'number' && Number.isFinite(step.index) ? Math.max(1, Math.floor(step.index)) : null
      const stepTotal =
        typeof step?.total === 'number' && Number.isFinite(step.total)
          ? Math.max(stepIndex || 1, Math.floor(step.total))
          : null
      enqueue(`worker_llm_stage:${stage}`, async () => {
        await reportTaskProgress(job, 65, {
          stage: stageKey,
          stageLabel,
          displayMode: 'detail',
          message: stageLabel,
          streamRunId: streamContext.streamRunId,
          ...(stepId ? { stepId } : {}),
          ...(stepAttempt ? { stepAttempt } : {}),
          ...(stepTitle ? { stepTitle } : {}),
          ...(stepIndex ? { stepIndex } : {}),
          ...(stepTotal ? { stepTotal } : {}),
          meta: {
            provider: provider || null,
          },
        })
      })
    },
    onChunk: ({ kind, delta, lane, step }) => {
      ensureActiveOrThrow('worker_llm_stream')
      scheduleActiveProbe()
      if (!delta) return
      const stepId = typeof step?.id === 'string' && step.id.trim() ? step.id.trim() : null
      const stepAttempt =
        typeof step?.attempt === 'number' && Number.isFinite(step.attempt)
          ? Math.max(1, Math.floor(step.attempt))
          : null
      const stepTitle = typeof step?.title === 'string' && step.title.trim() ? step.title.trim() : null
      const stepIndex =
        typeof step?.index === 'number' && Number.isFinite(step.index) ? Math.max(1, Math.floor(step.index)) : null
      const stepTotal =
        typeof step?.total === 'number' && Number.isFinite(step.total)
          ? Math.max(stepIndex || 1, Math.floor(step.total))
          : null
      const laneKey = lane || (kind === 'reasoning' ? 'reasoning' : 'main')
      const bufferKey = `${stepId || '__default'}|${laneKey}|${kind}`
      const existing = pendingChunks.get(bufferKey)
      if (existing) {
        existing.text += delta
      } else {
        pendingChunks.set(bufferKey, {
          kind: kind as LLMStreamKind,
          lane: laneKey,
          text: delta,
          stepId,
          stepAttempt,
          stepTitle,
          stepIndex,
          stepTotal,
        })
      }
      scheduleChunkFlush()
    },
    onComplete: (text, step) => {
      ensureActiveOrThrow('worker_llm_complete')
      flushPendingChunks()
      const stepId = typeof step?.id === 'string' && step.id.trim() ? step.id.trim() : null
      const stepAttempt =
        typeof step?.attempt === 'number' && Number.isFinite(step.attempt)
          ? Math.max(1, Math.floor(step.attempt))
          : null
      const stepTitle = typeof step?.title === 'string' && step.title.trim() ? step.title.trim() : null
      const stepIndex =
        typeof step?.index === 'number' && Number.isFinite(step.index) ? Math.max(1, Math.floor(step.index)) : null
      const stepTotal =
        typeof step?.total === 'number' && Number.isFinite(step.total)
          ? Math.max(stepIndex || 1, Math.floor(step.total))
          : null
      enqueue('worker_llm_complete', async () => {
        await reportTaskProgress(job, 90, {
          stage: 'worker_llm_complete',
          stageLabel: 'progress.runtime.stage.llmCompleted',
          displayMode: 'detail',
          message: 'progress.runtime.llm.completed',
          done: true,
          ...(typeof text === 'string' ? { output: text } : {}),
          streamRunId: streamContext.streamRunId,
          ...(stepId ? { stepId } : {}),
          ...(stepAttempt ? { stepAttempt } : {}),
          ...(stepTitle ? { stepTitle } : {}),
          ...(stepIndex ? { stepIndex } : {}),
          ...(stepTotal ? { stepTotal } : {}),
        })
      })
    },
    onError: (error, step) => {
      if (error instanceof TaskTerminatedError) {
        markTerminated('worker_llm_error')
        throw error
      }
      ensureActiveOrThrow('worker_llm_error')
      const stepId = typeof step?.id === 'string' && step.id.trim() ? step.id.trim() : null
      const stepAttempt =
        typeof step?.attempt === 'number' && Number.isFinite(step.attempt)
          ? Math.max(1, Math.floor(step.attempt))
          : null
      const stepTitle = typeof step?.title === 'string' && step.title.trim() ? step.title.trim() : null
      const stepIndex =
        typeof step?.index === 'number' && Number.isFinite(step.index) ? Math.max(1, Math.floor(step.index)) : null
      const stepTotal =
        typeof step?.total === 'number' && Number.isFinite(step.total)
          ? Math.max(stepIndex || 1, Math.floor(step.total))
          : null
      enqueue('worker_llm_error', async () => {
        await reportTaskProgress(job, 90, {
          stage: 'worker_llm_error',
          stageLabel: 'progress.runtime.stage.llmFailed',
          displayMode: 'detail',
          message: error instanceof Error ? error.message : String(error),
          streamRunId: streamContext.streamRunId,
          ...(stepId ? { stepId } : {}),
          ...(stepAttempt ? { stepAttempt } : {}),
          ...(stepTitle ? { stepTitle } : {}),
          ...(stepIndex ? { stepIndex } : {}),
          ...(stepTotal ? { stepTotal } : {}),
        })
      })
    },
    async flush() {
      flushPendingChunks()
      await publishQueue.catch(() => undefined)
      if (terminatedError) {
        throw terminatedError
      }
    },
  }
}
