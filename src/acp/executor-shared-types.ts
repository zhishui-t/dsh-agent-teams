/**
 * Shared executor types extracted from the legacy DelegationService.
 *
 * These types are used by executor providers, ACP, knowledge injection and
 * stream/settings modules. Keeping them independent lets the legacy
 * delegation engine be removed without breaking those consumers.
 */

export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

export interface ContentBlockLike {
  type: 'text'
  text: string
}

export interface SubagentTaskOutput {
  id: string
  output: ContentBlockLike[]
  structured?: unknown
  diagnostic?: string
  stopReason: SubagentStopReason
  duration_ms: number
  weave?: {
    errorType: string | null
    status: 'COMPLETED' | 'CANCELLED' | 'FAILED'
    countBreaker: boolean
  }
}

export interface DelegationResultLike {
  output: ContentBlockLike[]
  structured?: unknown
  diagnostic?: string
  stopReason: SubagentStopReason
}

export interface DelegationRunEventLike {
  type?: string
  text?: string
  name?: string
  data?: unknown
  sessionId?: string
}

export interface DelegationRunLike {
  id: string
  sessionId?: string
  localAgent?: unknown
  result: Promise<DelegationResultLike>
  dispose(): Promise<void>
  onEvent?(listener: (event: DelegationRunEventLike) => void): () => void
  readOutput?(): DelegationRunEventLike[]
}

/** TDD 2.3 知识注入限额（团队级唯一来源，ME-2）。 */
export interface KnowledgeInjectionLimits {
  max_entries: number
  max_chars_per_entry: number
  max_total_chars: number
  priority: 'freshness_first'
}

export type ExecutorRunEventType = 'status' | 'output' | 'reasoning' | 'tool_call' | 'tool_result'

export interface ExecutorRunEvent {
  taskId: string
  executor: string
  runId: string
  sessionId?: string
  type: ExecutorRunEventType
  text?: string
  name?: string
  data?: unknown
}
