import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { Readable, Writable } from 'node:stream'

import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'
import { applyRuntimeIntents, BUILTIN_ACP_EXTENSIONS, negotiateExtensions, type AcpCapabilityApplication, type AcpExtensionCallContext, type AcpExtensionProbeInput, type AcpIntentKey, type AcpProviderExtension, type ExtensionNegotiationEntry } from './provider-extension.js'
import type { ExecutorCapabilities, ExecutorProviderMetadata, ExecutorRun, ExecutorSessionConfig, ExecutorStartRequest } from './executor-provider.js'
import type { DelegationRunLike } from './executor-shared-types.js'

export type AcpExecutorEventType =
  | 'status'
  | 'output'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'

export interface AcpExecutorEvent {
  taskId?: string
  executor?: string
  runId?: string
  sessionId?: string
  type: AcpExecutorEventType
  text?: string
  name?: string
  data?: unknown
  at: number
}

export interface AcpAgentInfo {
  name?: string
  title?: string
  version?: string
}

export interface AcpAgentCapabilities {
  loadSession?: boolean
  promptCapabilities?: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
  mcpCapabilities?: {
    http?: boolean
    sse?: boolean
  }
  sessionCapabilities?: {
    list?: unknown
    resume?: unknown
    fork?: unknown
  }
  _meta?: unknown
}

export interface AcpAuthMethod {
  id?: string
  name?: string
  description?: string
}

export interface AcpInitializeResponse {
  protocolVersion?: number | string
  agentInfo?: AcpAgentInfo
  agentCapabilities?: AcpAgentCapabilities
  authMethods?: AcpAuthMethod[]
  _meta?: unknown
}

export interface AcpSelectOption {
  value: string
  name?: string
}

export interface AcpConfigOption {
  id: string
  name?: string
  category?: string
  type?: string
  currentValue?: string
  options?: AcpSelectOption[]
}

export interface AcpModeState {
  currentModeId?: string
  availableModes?: Array<{ id: string; name?: string }>
}

export interface AcpSessionNewResponse {
  sessionId: string
  modes?: AcpModeState
  configOptions?: AcpConfigOption[]
}

export interface AcpSessionProviderConfig {
  name: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  permission?: 'allow' | 'reject'
  /** ACP 会话创建时挂载的 MCP 服务器列表；缺省不挂载。 */
  mcpServers?: unknown[]
  /**
   * t7：声明该 provider 支持的扩展名。协商要求「声明 ∧ initialize 探测」双命中，
   * 未命中（未声明/探测失败/未知名）一律降级并在 status 事件中报告原因。
   * 缺省视为 ['zcode'] 以保持既有行为；显式空数组表示纯标准 ACP。
   */
  declaredExtensions?: string[]
  /**
   * sessionKey→acpSid 持久索引文件（iso-1 会话隔离）。
   * 缺省关闭（纯内存隔离，与既有行为一致）；生产接线传 DEFAULT_ACP_SESSION_INDEX_FILE，
   * 使桥接/插件重启后同 sessionKey 仍续接同一占位符（进而同一 zcode 会话），
   * 不同 sessionKey 各自独立会话、互不阻塞互不染上下文。
   */
  sessionIndexFile?: string
}

/** t7 运行时挂钩：把扩展协商 / update 变换注入协议内核。 */
export interface AcpProviderRuntimeHooks {
  resolveExtensions(probe: AcpExtensionProbeInput): { active: AcpProviderExtension[]; report: ExtensionNegotiationEntry[] }
  transformUpdate?(update: AcpSessionUpdate): Array<Omit<AcpExecutorEvent, 'at'>> | undefined
}

/** 默认挂钩：按 config.declaredExtensions 对内置扩展注册表协商（缺省 ['zcode']）。 */
export function defaultRuntimeHooks(declaredExtensions?: readonly string[]): AcpProviderRuntimeHooks {
  const declared = declaredExtensions ?? ['zcode']
  return {
    resolveExtensions(probe) {
      return negotiateExtensions(declared, BUILTIN_ACP_EXTENSIONS, probe)
    },
  }
}

interface SpawnedProcess {
  pid?: number
  stdin?: unknown
  stdout?: unknown
  done: Promise<unknown>
  waitForExit(signal?: AbortSignal): Promise<void>
  terminate(): Promise<void> | void
}

interface AcpConnectionLike {
  initialize(params: unknown): Promise<unknown>
  newSession(params: { cwd: string; mcpServers: unknown[] }): Promise<{ sessionId: string }>
  loadSession?(params: { sessionId: string; cwd: string; mcpServers: unknown[] }): Promise<unknown>
  /**
   * ACP `session/resume`（SDK ClientSideConnection.resumeSession → JSONRPC session/resume）。
   * 语义：续上下文但不回放历史（区别于 session/load）。zcode 桥声明
   * sessionCapabilities.resume 并与 session/load 共用同一 lazy-alias 恢复链，
   * 因此它是 load 失败后的第二级恢复手段。
   */
  resumeSession?(params: { sessionId: string; cwd: string; mcpServers?: unknown[] }): Promise<unknown>
  prompt(params: { sessionId: string; prompt: Array<{ type: 'text'; text: string }> }): Promise<{ stopReason: string }>
  cancel(params: { sessionId: string }): Promise<void>
  extMethod(method: string, params: Record<string, unknown>): Promise<unknown>
  signal: AbortSignal
}

export interface AcpSessionConnection {
  key: string
  conn: AcpConnectionLike
  process: SpawnedProcess
  dead: boolean
  sessions: Set<string>
  initializeResponse?: AcpInitializeResponse
  handleSessionUpdate?(update: AcpSessionUpdate): void
  cwd?: string
  newSession?: AcpConnectionLike['newSession']
}

export interface AcpSessionUpdate {
  sessionId?: string
  sessionUpdate?: string
  content?: { type?: string; text?: string }
  title?: string
  status?: string
  toolCallId?: string
}

export interface AcpSessionFactoryConnection {
  key: string
  cwd?: string
  sessions: Set<string>
  initializeResponse?: AcpInitializeResponse
  initialize(params: unknown): Promise<unknown>
  newSession(params: { cwd: string; mcpServers: unknown[] }): Promise<{ sessionId: string }>
  loadSession?(params: { sessionId: string; cwd: string; mcpServers: unknown[] }): Promise<unknown>
  resumeSession?(params: { sessionId: string; cwd: string; mcpServers?: unknown[] }): Promise<unknown>
  prompt(params: { sessionId: string; prompt: Array<{ type: 'text'; text: string }> }): Promise<{ stopReason: string }>
  cancel(params: { sessionId: string }): Promise<void>
  extMethod(method: string, params: Record<string, unknown>): Promise<unknown>
  signal: AbortSignal
  handleSessionUpdate?(update: AcpSessionUpdate): void
}

interface SessionRecord {
  sessionId: string
  connectionKey: string
}

/**
 * sessionKey 维度持久索引单条记录。
 *
 * resume 线索（宿主重启后沿用老会话的依据）：
 * - acpSid 本身就是「可恢复句柄」——zcode 桥的 durable store
 *   （~/.zcode/v2/acp-lazy-sessions.json）以 acp_sid→{cwd,zcodeSid} 持久化别名，
 *   session/resume 与 session/load 都经 resolveResumeTarget→lookupLazySession
 *   从上一代桥恢复占位会话（zcode-acp-server handlers/session.js resolveResumeTarget/
 *   ensureRealSession：带 zcodeSid 的记录仅重注册别名，不带则物化新后端会话）。
 * - cwd：会话创建时声明的工作区，作为 load/resume 形参的旧线索
 *   （桥侧 resume/load 不信任客户端 cwd；对遵循 ACP 语义的 agent 是准确定位线索）。
 * - zcodeSid：前向兼容字段。桥从不向客户端回传后端 sid，provider 通常拿不到；
 *   一旦未来桥回传即可跳过别名解析直达后端会话。
 */
export interface SessionKeyIndexRecord {
  acpSid: string
  updatedAt: number
  cwd?: string
  zcodeSid?: string
}

/** 索引文件形态：version 兜底前向兼容；只增改不删，旧数据兼容不丢。 */
export interface SessionKeyIndexFile {
  version: 1
  keys: Record<string, SessionKeyIndexRecord>
}

/** 生产缺省索引路径（~/.dsh/weave/acp-session-index.json）；构造时可覆盖。 */
export const DEFAULT_ACP_SESSION_INDEX_FILE = join(homedir(), '.dsh', 'weave', 'acp-session-index.json')

/** 合法 sessionKey：非空且不等于历史 "undefined" 键（生产旧路径 sessionKey 未传的脏数据）。 */
function normalizeSessionKey(sessionKey: string | undefined): string | undefined {
  if (typeof sessionKey !== 'string') return undefined
  const trimmed = sessionKey.trim()
  return trimmed !== '' && trimmed !== 'undefined' ? trimmed : undefined
}

/** 读持久索引（best-effort：任何异常按无记录处理，绝不阻断委托）。 */
function readSessionIndexFile(file: string | undefined, sessionKey: string): SessionKeyIndexRecord | undefined {
  if (!file) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionKeyIndexFile>
    const record = raw?.keys?.[sessionKey]
    if (typeof record?.acpSid !== 'string' || record.acpSid === '') return undefined
    const clue = (value: unknown): string | undefined =>
      typeof value === 'string' && value !== '' ? value : undefined
    return {
      acpSid: record.acpSid,
      updatedAt: Number(record.updatedAt) || 0,
      ...(clue(record.cwd) !== undefined ? { cwd: clue(record.cwd) } : {}),
      ...(clue(record.zcodeSid) !== undefined ? { zcodeSid: clue(record.zcodeSid) } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * 写持久索引（读改写合并；失败仅吞掉——别名库本身在桥接侧另有 durable 副本）。
 * `cwd` 是本次会话的 resume 线索：仅在该 sid 首次入索引时生效——同 sid 复写
 * 保留旧线索（会话真实创建工作区不随宿主 cwd 漂移），sid 变更（自愈新建）时
 * 旧线索整体作废、不得迁移。
 */
function writeSessionIndexFile(file: string | undefined, sessionKey: string, acpSid: string, cwd?: string): void {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    let base: SessionKeyIndexFile = { version: 1, keys: {} }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionKeyIndexFile>
      if (raw && typeof raw === 'object' && raw.keys && typeof raw.keys === 'object') {
        const cleaned: Record<string, SessionKeyIndexRecord> = {}
        let dropped = 0
        for (const [key, value] of Object.entries(raw.keys as Record<string, SessionKeyIndexRecord>)) {
          const cleanKey = normalizeSessionKey(key)
          if (cleanKey && value && typeof value.acpSid === 'string' && value.acpSid !== '') {
            cleaned[cleanKey] = value
          } else {
            dropped += 1
          }
        }
        if (dropped > 0) {
          console.warn(`[dsh-weave] acp-session-index: dropped ${dropped} invalid key(s) (legacy "undefined"/empty sessionKey) while rewriting`)
        }
        base = { version: 1, keys: cleaned }
      }
    } catch {
      // 首次写或旧文件损坏：从空表起写。
    }
    base.version = 1
    const prior = base.keys[sessionKey]
    const carried = prior?.acpSid === acpSid ? prior : undefined
    // 同 sid：保留原创建 cwd（会话真实工作区不随宿主 cwd 漂移）；sid 变更/首次：
    // 记录本次声明（新会话就是在当前 cwd 下创建的）。
    const clueCwd = carried?.cwd ?? cwd
    base.keys[sessionKey] = {
      acpSid,
      updatedAt: Date.now(),
      ...(clueCwd !== undefined ? { cwd: clueCwd } : {}),
      ...(carried?.zcodeSid !== undefined ? { zcodeSid: carried.zcodeSid } : {}),
    }
    writeFileSync(file, `${JSON.stringify(base, null, 2)}\n`, 'utf8')
  } catch {
    // 索引写失败不影响运行时隔离（内存 map 已按 sessionKey 隔离）。
  }
}

interface StartOptions {
  sessionKey?: string
  resumeSessionId?: string
  modelProvider?: string
  model?: string
  thoughtLevel?: string
  mode?: string
}

interface RunController {
  events: AcpExecutorEvent[]
  listeners: Set<(event: AcpExecutorEvent) => void>
  output: Array<{ type: 'text'; text: string }>
}

export interface AcpSessionStartRequest {
  executor?: string
  /** ACP 会话隔离主键；旧调用可能只经 weave.sessionKey 携带。 */
  sessionKey?: string
  prompt: Array<{ type: string; text?: string }>
  parent?: unknown
  signal: AbortSignal
  weave?: StartOptions
}

export interface AcpSessionRun extends Omit<DelegationRunLike, 'result'> {
  id: string
  localAgent: undefined
  result: Promise<{
    output: Array<{ type: string; text?: string }>
    stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
    /** t7：经扩展框架应用后的逐意图可观测报告（键为 model/thought/mode/tools）。 */
    intentApplied?: Partial<Record<AcpIntentKey, AcpCapabilityApplication>>
    applied?: {
      model?: { requested?: unknown; effective?: unknown; supported: boolean }
      thinking?: { requested?: unknown; effective?: unknown; supported: boolean }
      mode?: { requested?: unknown; effective?: unknown; supported: boolean }
      tools?: { requested?: unknown; effective?: unknown; supported: boolean; fallback?: boolean }
    }
  }>
  dispose(): Promise<void>
  readOutput(): AcpExecutorEvent[]
  onEvent(listener: (event: AcpExecutorEvent) => void): () => void
  initializeResponse?: AcpInitializeResponse
  sessionResponse?: AcpSessionNewResponse
  configOptions?: AcpConfigOption[]
  providerMetadata?: ExecutorProviderMetadata
  sessionConfig?: ExecutorSessionConfig
  /** t7：意图应用报告（同步快照；与 result 内一致）。 */
  intentApplied?: Partial<Record<AcpIntentKey, AcpCapabilityApplication>>
}

async function disposeProcess(process: SpawnedProcess, eofGraceMs: number): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), eofGraceMs)
  try {
    ;(process.stdin as { end?: () => void } | undefined)?.end?.()
    await process.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

function normalizeAcpStopReason(reason: string): 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' {
  if (reason === 'end_turn') return 'completed'
  if (reason === 'cancelled') return 'aborted'
  if (reason === 'max_tokens') return 'max-tokens'
  if (reason === 'refusal') return 'refusal'
  return 'error'
}

export class AcpSessionProvider {
  readonly name: string
  readonly capabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
  readonly inheritsParentContext = false

  readonly #command: string
  readonly #args: string[]
  readonly #configuredCwd?: string
  readonly #env: Record<string, string>
  readonly #permission: 'allow' | 'reject'
  readonly #mcpServers: unknown[]
  readonly #spawn: AcpSpawn['spawn']
  readonly #connect?: (cwd: string, key: string) => Promise<AcpSessionFactoryConnection>
  readonly #connections = new Map<string, AcpSessionConnection>()
  readonly #sessions = new Map<string, SessionRecord>()
  readonly #prompts = new Map<string, Promise<unknown>>()
  readonly #runs = new Map<string, RunController>()
  #sessionCatalog?: AcpSessionNewResponse

  readonly #hooks: AcpProviderRuntimeHooks
  readonly #declaredExtensions: readonly string[]
  readonly #sessionIndexFile?: string

  constructor(
    config: AcpSessionProviderConfig,
    spawn: AcpSpawn['spawn'],
    connect?: (cwd: string, key: string) => Promise<AcpSessionFactoryConnection>,
    hooks?: AcpProviderRuntimeHooks,
  ) {
    this.name = config.name
    this.#command = config.command
    this.#args = config.args ?? []
    this.#configuredCwd = config.cwd
    this.#env = config.env ?? {}
    this.#permission = config.permission ?? 'reject'
    this.#mcpServers = config.mcpServers ?? []
    this.#spawn = spawn
    this.#connect = connect
    this.#declaredExtensions = config.declaredExtensions ?? ['zcode']
    // iso-1：sessionKey→acpSid 持久索引（可选）。缺省关闭以保持既有纯内存行为。
    this.#sessionIndexFile = config.sessionIndexFile
    // 显式 hooks 优先；否则按声明对内置注册表协商（探测失败自动降级）。
    this.#hooks = hooks ?? defaultRuntimeHooks(this.#declaredExtensions)
  }

  async start(request: AcpSessionStartRequest): Promise<AcpSessionRun> {
    if (request.signal.aborted) throw new Error(`${this.name}: aborted before ACP session started`)

    const weave = request.weave ?? {}
    const parent = request.parent as { session?: { header?: { cwd?: string } } } | undefined
    const cwd = this.#configuredCwd ?? parent?.session?.header?.cwd
    if (!cwd) throw new Error(`${this.name}: cwd is required`)

    // iso-1 会话隔离：顶层 sessionKey 是 DSH 透传的规范主键，weave.sessionKey
    // 仅兼容历史调用。两者皆缺时必须 fail fast——绝不能回落到 undefined 键，
    // 否则多个角色会复用同一 ACP/zcode 会话（索引文件出现 "undefined" 脏键）。
    const sessionKey = normalizeSessionKey(request.sessionKey) ?? normalizeSessionKey(weave.sessionKey)
    if (sessionKey === undefined) {
      throw new Error(`${this.name}: sessionKey is required for ACP session isolation`)
    }
    const connection = await this.#acquireConnection(cwd)
    // 会话解析优先级（iso-1）：显式 resume > 进程内内存表 > 持久索引。
    // 重启后内存表清空，持久索引让同 sessionKey 续接原占位符（桥接按别名物化，
    // 已带 zcodeSid 的记录直达同一后端会话），不同 sessionKey 天然各得独立会话。
    const indexed = readSessionIndexFile(this.#sessionIndexFile, sessionKey)
    let sessionId =
      weave.resumeSessionId ??
      this.#sessions.get(sessionKey)?.sessionId ??
      indexed?.acpSid
    let sessionResponse: AcpSessionNewResponse | undefined
    const knownInConnection = sessionId !== undefined && connection.sessions.has(sessionId)

    if (sessionId === undefined || !knownInConnection) {
      if (sessionId !== undefined) {
        // 旧线索：索引记录里会话创建时声明的 cwd（resume 线索）；无记录时用当前 cwd。
        const resumeCwd = sessionId === indexed?.acpSid ? indexed?.cwd ?? cwd : cwd
        const recovered = await this.#tryRecoverSession(connection, sessionId, resumeCwd)
        if (recovered !== undefined) {
          sessionResponse = recovered
        } else {
          // 恢复链（load+resume）全部失败：占位符确实失效（30d TTL 清理/后端会话
          // 已删/记录损坏）——自愈回退到新建会话，并让下方索引写入覆盖掉失效映射
          // （sid 变更，旧线索不随迁，见 writeSessionIndexFile）。
          sessionId = undefined
          this.#sessions.delete(sessionKey)
        }
      }
      if (sessionId === undefined) {
        const created = await connection.conn.newSession({ cwd, mcpServers: this.#mcpServers })
        sessionId = created.sessionId
        sessionResponse = created
      }
      this.#sessions.set(sessionKey, { sessionId, connectionKey: connection.key })
      writeSessionIndexFile(this.#sessionIndexFile, sessionKey, sessionId, cwd)
    } else {
      // 连接仍认识该会话：仅补写持久索引（防旧版本运行期未落盘的键/线索缺失）。
      writeSessionIndexFile(this.#sessionIndexFile, sessionKey, sessionId, cwd)
    }

    const runId = `acp-${sessionId}`
    const controller = this.#startRunController(runId)

    // t7：扩展协商（声明 ∧ initialize 探测）→ 意图应用 → 逐项可观测降级。
    if ((weave.modelProvider !== undefined || weave.model !== undefined) && !weave.model) {
      throw new Error(`${this.name}: model is required`)
    }
    const probe: AcpExtensionProbeInput = connection.initializeResponse
      ? {
          agentInfo: connection.initializeResponse.agentInfo,
          agentCapabilities: connection.initializeResponse.agentCapabilities,
          meta: connection.initializeResponse._meta,
        }
      : {}
    const negotiation = this.#hooks.resolveExtensions(probe)
    const extCtx: AcpExtensionCallContext = {
      extMethod: (method, params) => connection.conn.extMethod(method, params),
    }
    const { applied } = await applyRuntimeIntents(
      negotiation.active,
      {
        sessionId,
        ...(weave.modelProvider !== undefined ? { modelProvider: weave.modelProvider } : {}),
        ...(weave.model !== undefined ? { model: weave.model } : {}),
        ...(weave.thoughtLevel !== undefined ? { thoughtLevel: weave.thoughtLevel } : {}),
        ...(weave.mode !== undefined ? { mode: weave.mode } : {}),
      },
      extCtx,
    )
    const activeNames = negotiation.active.map((extension) => extension.name)
    const degraded = negotiation.report.filter((entry) => entry.status === 'inactive')
    this.#emit(controller, {
      type: 'status',
      text:
        `extensions=${activeNames.length > 0 ? activeNames.join(',') : 'none'}` +
        (degraded.length > 0 ? ` (${degraded.map((d) => `${d.name}:${d.reason}`).join('; ')})` : ''),
    })
    for (const [key, item] of Object.entries(applied)) {
      if (!item) continue
      if (item.supported) {
        this.#emit(controller, { type: 'status', text: `${key}=${String(item.effective ?? '')}` })
      } else {
        this.#emit(controller, { type: 'status', text: `${key} unsupported (fallback; ${item.detail ?? 'no detail'})` })
      }
    }

    const previous = this.#prompts.get(sessionKey) ?? Promise.resolve()
    const queuedPrompt = previous.catch(() => undefined).then(async () => {
      const result = await connection.conn.prompt({
        sessionId,
        prompt: request.prompt.filter((block): block is { type: 'text'; text: string } => block.type === 'text'),
      })
      return {
        output: [...controller.output],
        stopReason: normalizeAcpStopReason(result.stopReason),
        ...(Object.keys(applied).length > 0 ? { intentApplied: applied } : {}),
      }
    })

    this.#prompts.set(sessionKey, queuedPrompt)
    const cancel = (): void => {
      connection.conn.cancel({ sessionId }).catch(() => undefined)
    }
    if (request.signal.aborted) cancel()
    else request.signal.addEventListener('abort', cancel, { once: true })

    const result = queuedPrompt.finally(() => {
      if (this.#prompts.get(sessionKey) === queuedPrompt) this.#prompts.delete(sessionKey)
      request.signal.removeEventListener('abort', cancel)
    })

    return {
      id: runId,
      localAgent: undefined,
      result,
      ...(Object.keys(applied).length > 0 ? { intentApplied: applied } : {}),
      dispose: async () => {
        cancel()
        await result.catch(() => undefined)
      },
      readOutput: () => [...controller.events],
      onEvent: (listener) => {
        controller.listeners.add(listener)
        return () => controller.listeners.delete(listener)
      },
      initializeResponse: connection.initializeResponse,
      ...(sessionResponse !== undefined ? { sessionResponse } : {}),
      ...(sessionResponse?.configOptions !== undefined ? { configOptions: sessionResponse.configOptions } : {}),
      providerMetadata: connection.initializeResponse ? {
        protocolVersion: connection.initializeResponse.protocolVersion,
        agentInfo: connection.initializeResponse.agentInfo,
        agentCapabilities: connection.initializeResponse.agentCapabilities,
        authMethods: connection.initializeResponse.authMethods,
      } : undefined,
      sessionConfig: sessionResponse ? {
        modes: sessionResponse.modes,
        configOptions: sessionResponse.configOptions,
      } : undefined,
    }
  }

  /**
   * 会话是否已存在（当前连接已知，或持久索引有可恢复线索）。
   * 调度侧据此决定“首次真正创建会话才全量注入角色/纪律”，复用会话只注入任务段。
   */
  isSessionKnown(sessionKey: string): boolean {
    const normalized = normalizeSessionKey(sessionKey)
    if (normalized === undefined) return false
    if (this.#sessions.has(normalized)) return true
    return readSessionIndexFile(this.#sessionIndexFile, normalized) !== undefined
  }

  /**
   * 跨生命周期会话恢复链：session/load → session/resume，全部失败返回 undefined
   * （调用方回落 newSession 自愈）。链上每一环的异常都必须在本方法内接住——
   * 任何一处冒泡到 start() 都会被 delegation 层包装成 WeaveError('execution_failed')，
   * 把一次本可自愈的会话恢复失败毒化成整次委托失败（实锚过的毒化场景）。
   *
   * 为什么 resume 可直达、无需 extMethod reattach（读 zcode-acp-server 0.11.9 源码实证）：
   * - initialize 声明 agentCapabilities.loadSession=true 且
   *   sessionCapabilities={list,resume,fork}（dist/server.js initialize）；
   * - session/resume 与 session/load 共用 resolveResumeTarget：内存映射 → pending
   *   物化 → lookupLazySession（~/.zcode/v2/acp-lazy-sessions.json 的
   *   acp_sid→{cwd,zcodeSid} durable 别名，跨桥进程存活）→ ensureRealSession
   *   重注册别名/物化后端会话（dist/handlers/session.js）；带 zcodeSid 的记录
   *   仅重注册别名，即可对本代后端发起 resume RPC 恢复同一上下文。
   * - 两级恢复的差别只在 load 额外做历史回放（fetchMessages+replay+plan+usage）：
   *   回放环节失败（历史 slice 损坏等）时 resume 仍可续上下文——这正是第二级的价值。
   * - 桥的 extMethod 面无 session_info/reattach 类方法（dist/handlers/extensions.js
   *   仅 fork/goal/compact/setModel/setMode 等），不存在旁路 reattach 通道，亦不需要。
   */
  async #tryRecoverSession(
    connection: AcpSessionConnection,
    sessionId: string,
    cwd: string,
  ): Promise<AcpSessionNewResponse | undefined> {
    const conn = connection.conn
    if (typeof conn.loadSession === 'function') {
      try {
        const loaded = (await conn.loadSession({ sessionId, cwd, mcpServers: this.#mcpServers })) as
          | Partial<AcpSessionNewResponse>
          | undefined
        connection.sessions.add(sessionId)
        return { ...loaded, sessionId }
      } catch {
        // 落到下一级恢复手段，不在本层上报。
      }
    }
    if (typeof conn.resumeSession === 'function') {
      try {
        const resumed = (await conn.resumeSession({ sessionId, cwd, mcpServers: this.#mcpServers })) as
          | Partial<AcpSessionNewResponse>
          | undefined
        connection.sessions.add(sessionId)
        return { ...resumed, sessionId }
      } catch {
        // 两级恢复都失败：由调用方自愈新建。
      }
    }
    return undefined
  }

  /**
   * 读取一次 session/new 返回的 modes/configOptions。
   * ACP 的 lazy session 不会创建后端会话，因此该调用只用于能力发现。
   */
  async describeSession(cwd?: string): Promise<AcpSessionNewResponse | undefined> {
    if (this.#sessionCatalog) return this.#sessionCatalog
    const targetCwd = cwd ?? this.#configuredCwd ?? process.cwd()
    const connection = await this.#acquireConnection(targetCwd)
    const response = await connection.conn.newSession({
      cwd: targetCwd,
      mcpServers: this.#mcpServers,
    }) as AcpSessionNewResponse
    this.#sessionCatalog = response
    return response
  }

  async dispose(): Promise<void> {
    const processes = [...this.#connections.values()].map((item) => item.process)
    this.#connections.clear()
    this.#sessions.clear()
    this.#prompts.clear()
    this.#runs.clear()
    await Promise.allSettled(processes.map((item) => disposeProcess(item, 3000)))
  }

  #handleSessionUpdate(connection: AcpSessionConnection, update: AcpSessionUpdate): void {
    if (update.sessionId) connection.sessions.add(update.sessionId)
    const controller = this.#runs.get(`acp-${update.sessionId}`)
    if (!controller) return

    // t7：provider-specific update 变换优先；未处理时回落协议内核默认映射。
    const custom = this.#hooks.transformUpdate?.(update)
    if (custom && custom.length > 0) {
      for (const event of custom) {
        const full: AcpExecutorEvent = { ...event, at: Date.now() }
        controller.events.push(full)
        for (const listener of controller.listeners) {
          try {
            listener(full)
          } catch {
            // 观察者异常不阻断主链路。
          }
        }
      }
      return
    }

    const push = (event: Omit<AcpExecutorEvent, 'at'>) => {
      const full: AcpExecutorEvent = { ...event, at: Date.now() }
      controller.events.push(full)
      for (const listener of controller.listeners) listener(full)
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      const outputText = update.content?.type === 'text' ? update.content.text : undefined
      if (typeof outputText === 'string') {
        controller.output.push({ type: 'text', text: outputText })
        push({ type: 'output', text: outputText })
      }
      return
    }
    if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
      push({ type: 'reasoning', text: update.content.text })
      return
    }
    if (update.sessionUpdate === 'tool_call') {
      push({ type: 'tool_call', name: update.title, data: update })
      return
    }
    if (update.sessionUpdate === 'tool_call_update') {
      push({ type: 'tool_result', name: update.toolCallId, data: update })
    }
  }

  async #acquireConnection(cwd: string): Promise<AcpSessionConnection> {
    const key = `${this.#command}:${this.#args.join(' ')}:${cwd}`
    const existing = this.#connections.get(key)
    if (existing && !existing.dead) return existing

    if (this.#connect) {
      const factory = await this.#connect(cwd, key)
      const initializeResponse = factory.initializeResponse ??
        await factory.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
        }) as AcpInitializeResponse
      const connection: AcpSessionConnection = {
        ...factory,
        conn: factory,
        initializeResponse,
        process: {
          done: new Promise(() => undefined),
          waitForExit: async () => undefined,
          terminate: async () => undefined,
        },
        dead: false,
        handleSessionUpdate: (update) => this.#handleSessionUpdate(connection, update),
      }
      factory.handleSessionUpdate = connection.handleSessionUpdate
      this.#connections.set(key, connection)
      return connection
    }

    const child = this.#spawn({
      argv: [this.#command, ...this.#args],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3000,
      env: this.#env,
    })
    if (!child.stdin || !child.stdout) throw new Error(`${this.name}: ACP stdin/stdout streams are required`)

    const permission = this.#permission
    const connection: AcpSessionConnection = {
      key,
      conn: undefined as unknown as AcpConnectionLike,
      process: child,
      dead: false,
      sessions: new Set(),
      handleSessionUpdate: (update) => this.#handleSessionUpdate(connection, update),
    }

    const client = {
      requestPermission(params: {
        options: Array<{ kind?: string; optionId?: string | number }>
      }) {
        if (permission !== 'allow') return { outcome: { outcome: 'cancelled' } }
        const option =
          params.options.find((item) => item.kind === 'allow_once') ??
          params.options.find((item) => item.kind === 'allow_always') ??
          params.options[0]
        return option
          ? { outcome: { outcome: 'selected', optionId: option.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      },
      sessionUpdate(params: { sessionId?: string; update: AcpSessionUpdate }) {
        connection.handleSessionUpdate?.(mergeSessionUpdateNotification(params))
      },
    }

    const conn = new ClientSideConnection(
      () => client as never,
      ndJsonStream(
        Writable.toWeb(child.stdin as Parameters<typeof Writable.toWeb>[0]) as never,
        Readable.toWeb(child.stdout as Parameters<typeof Readable.toWeb>[0]) as never,
      ),
    )
    connection.conn = conn
    this.#connections.set(key, connection)
    conn.signal.addEventListener('abort', () => { connection.dead = true }, { once: true })

    connection.initializeResponse = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
    }) as AcpInitializeResponse
    return connection
  }

  #startRunController(runId: string): RunController {
    const existing = this.#runs.get(runId)
    if (existing) return existing
    const created: RunController = { events: [], listeners: new Set(), output: [] }
    this.#runs.set(runId, created)
    return created
  }

  #emit(controller: RunController, event: Omit<AcpExecutorEvent, 'at'>): void {
    const full: AcpExecutorEvent = { ...event, at: Date.now() }
    controller.events.push(full)
    for (const listener of controller.listeners) {
      try {
        listener(full)
      } catch {
        // UI / 观察者异常不影响 executor 主链路。
      }
    }
  }
}

/**
 * ACP `session/update` 通知的协议形态是顶层平铺 `{ sessionId, update }`——sessionId
 * 不在 update 对象内（P1-H 根因：曾按 update.sessionId 查 controller，恒 miss 致
 * 全部实时事件静默丢弃、委托侧只剩空闲超时误杀）。本函数把通知合并为内核映射
 * 所需的 AcpSessionUpdate（sessionId 内嵌）；update 自带 sessionId 时优先保留。
 */
export function mergeSessionUpdateNotification(params: {
  sessionId?: string
  update: AcpSessionUpdate
}): AcpSessionUpdate {
  return { ...params.update, sessionId: params.update.sessionId ?? params.sessionId }
}

export interface AcpSpawn {
  spawn(spec: {
    argv: string[]
    cwd?: string
    env?: Record<string, string>
    stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'inherit' | 'ignore' | 'pipe' }
    graceMs?: number
  }): SpawnedProcess
}

export interface AcpProviderRegistryContext {
  get?(name: string): unknown
  subagents?: {
    registerProvider(provider: unknown): () => void
  }
  subprocess?: {
    spawn(spec: Parameters<AcpSpawn['spawn']>[0]): SpawnedProcess
  }
}

/**
 * 从环境变量构造 ZCode ACP Provider 配置：
 * - WEAVE_ZCODE_ACP_SERVER：zcode-acp-server 的 dist/index.js 绝对路径
 * - WEAVE_ZCODE_BIN：ZCode CLI / zcode.cjs 路径
 * - WEAVE_ZCODE_NODE：可选，运行 ZCode 的 Node 可执行文件
 * - WEAVE_ZCODE_ACP_DEBUG：可选，设为 1 开启桥接诊断
 */
function firstExisting(paths: Array<string | undefined>): string | undefined {
  return paths.find((path): path is string => typeof path === 'string' && path !== '' && existsSync(path))
}

function discoverZcodeCli(env: NodeJS.ProcessEnv): string | undefined {
  const appDir = env.ZCODE_WINDOWS_APP_INSTALL_DIR ?? 'D:/Program Files/ZCode'
  return firstExisting([
    env.WEAVE_ZCODE_BIN,
    env.ZCODE_BIN,
    join(appDir, 'resources', 'glm', 'zcode.cjs'),
    'D:/Program Files/ZCode/resources/glm/zcode.cjs',
    'C:/Program Files/ZCode/resources/glm/zcode.cjs',
  ])
}

function discoverZcodeNode(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.WEAVE_ZCODE_NODE ?? env.ZCODE_NODE
  if (explicit) return explicit

  const major = Number(process.versions.node.split('.')[0])
  if (Number.isFinite(major) && major >= 22) return process.execPath

  return firstExisting([
    'D:/code/nodejs/node.exe',
    'C:/Program Files/nodejs/node.exe',
  ])
}

function discoverAcpServer(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('zcode-acp-server/package.json') as string
    const server = join(pkg.slice(0, -'package.json'.length), 'dist', 'index.js')
    return existsSync(server) ? server : undefined
  } catch {
    return undefined
  }
}

/**
 * 构造 ZCode ACP Provider 配置。显式环境变量优先；否则自动发现本地安装的
 * zcode-acp-server 与 ZCode CLI，避免要求用户手工配置。
 */
export function zcodeAcpProviderConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AcpSessionProviderConfig | undefined {
  const serverPath = env.WEAVE_ZCODE_ACP_SERVER ?? discoverAcpServer()
  const zcodeBin = discoverZcodeCli(env)
  if (!serverPath || !zcodeBin) return undefined

  const zcodeNode = discoverZcodeNode(env)
  if (!zcodeNode) return undefined

  const debug = env.WEAVE_ZCODE_ACP_DEBUG === '1'
  return {
    name: 'zcode',
    command: process.execPath,
    args: [serverPath],
    env: {
      ...Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
      ZCODE_BIN: zcodeBin,
      ZCODE_NODE: zcodeNode,
      ...(debug ? { ZCODE_ACP_DEBUG: '1' } : {}),
    },
    permission: 'reject',
  }
}

export function registerAcpSessionProvider(
  context: AcpProviderRegistryContext,
  config: AcpSessionProviderConfig,
): boolean {
  const subagents = (context.get?.('subagents') ?? context.subagents) as AcpProviderRegistryContext['subagents'] | undefined
  const subprocess = (context.get?.('subprocess') ?? context.subprocess) as AcpProviderRegistryContext['subprocess'] | undefined
  if (!subagents || !subprocess) return false

  const provider = new AcpSessionProvider(config, (spec) => subprocess.spawn(spec))
  subagents.registerProvider(provider)
  return true
}

export interface ZcodeAcpExecutorProviderOptions {
  /** 可被角色引用的 executor id；默认 `zcode`。 */
  executorIds?: string[]
  /** t7：按扩展声明覆盖默认能力面（未指定项沿用 ZCode 基线）。 */
  capabilitiesOverride?: Partial<ExecutorCapabilities>
}

/**
 * 把长连接 ACP Session Provider 适配成统一 ExecutorProvider。
 */
export class ZcodeAcpExecutorProvider {
  readonly #provider: AcpSessionProvider
  readonly #executorIds: Set<string>

  readonly id: string
  readonly name = 'ZCode ACP'
  readonly kind = 'acp'

  readonly capabilities: ExecutorCapabilities

  constructor(provider: AcpSessionProvider, options: ZcodeAcpExecutorProviderOptions = {}) {
    this.#provider = provider
    this.#executorIds = new Set(options.executorIds ?? [provider.name])
    this.id = provider.name
    this.capabilities = { ...ZCODE_BASE_CAPABILITIES, ...(options.capabilitiesOverride ?? {}) }
  }

  supports(executor: string): boolean {
    return this.#executorIds.has(executor)
  }

  /** 是否已有该 sessionKey 的可复用会话（供首次/复用注入决策）。 */
  isSessionKnown(sessionKey: string): boolean {
    return this.#provider.isSessionKnown(sessionKey)
  }

  /** 转发底层 ACP session/new 能力目录。 */
  describeSession(cwd?: string): Promise<AcpSessionNewResponse | undefined> {
    return this.#provider.describeSession(cwd)
  }

  async start(request: ExecutorStartRequest): Promise<ExecutorRun> {
    const weave = request.runtime?.model
      ? {
          sessionKey: request.sessionKey,
          ...(request.resumeSessionId !== undefined ? { resumeSessionId: request.resumeSessionId } : {}),
          ...(request.runtime.model.provider !== undefined ? { modelProvider: request.runtime.model.provider } : {}),
          ...(request.runtime.model.id !== undefined ? { model: request.runtime.model.id } : {}),
          ...(request.runtime?.thoughtLevel !== undefined ? { thoughtLevel: request.runtime.thoughtLevel } : {}),
          ...(request.runtime?.mode !== undefined ? { mode: request.runtime.mode } : {}),
        }
      : {
          sessionKey: request.sessionKey,
          ...(request.resumeSessionId !== undefined ? { resumeSessionId: request.resumeSessionId } : {}),
          ...(request.runtime?.thoughtLevel !== undefined ? { thoughtLevel: request.runtime.thoughtLevel } : {}),
          ...(request.runtime?.mode !== undefined ? { mode: request.runtime.mode } : {}),
        }

    const run = await this.#provider.start({
      sessionKey: request.sessionKey,
      parent: request.parent,
      signal: request.signal,
      prompt: request.prompt.map((block) => ({
        type: 'text' as const,
        ...(typeof block.text === 'string' ? { text: block.text } : {}),
      })) as Array<{ type: 'text'; text: string }>,
      weave,
    })

    const sessionId = run.id.startsWith('acp-') ? run.id.slice(4) : run.id
    const decorate = (event: AcpExecutorEvent) => ({
      ...event,
      taskId: request.executor,
      executor: request.executor,
      runId: run.id,
      sessionId: event.sessionId ?? sessionId,
    })

    // t7：扩展框架真实报告优先；底层为 mock/无意图时回落既有默认（兼容旧契约）。
    const report = run.intentApplied
    const applied = {
      model:
        report?.model ??
        { requested: request.runtime?.model, effective: request.runtime?.model, supported: true },
      thinking:
        report?.thought ??
        { requested: request.runtime?.thoughtLevel, effective: request.runtime?.thoughtLevel, supported: true },
      mode:
        report?.mode ??
        { requested: request.runtime?.mode, effective: request.runtime?.mode, supported: true },
      tools:
        report?.tools ??
        {
          requested: request.runtime?.tools,
          effective: { management: 'external', permission: 'reject' },
          supported: false,
          fallback: true,
        },
    }

    const init = run.initializeResponse
    return {
      ...run,
      providerId: this.id,
      sessionId,
      result: run.result.then((result) => ({ ...result, applied })),
      applied,
      readOutput: () => run.readOutput().map(decorate),
      onEvent: (listener) => run.onEvent((event) => listener(decorate(event))),
      providerMetadata: init ? {
        protocolVersion: init.protocolVersion,
        agentInfo: init.agentInfo,
        agentCapabilities: init.agentCapabilities,
        authMethods: init.authMethods,
      } : undefined,
      sessionConfig: run.sessionResponse ? {
        modes: run.sessionResponse.modes,
        configOptions: run.sessionResponse.configOptions,
      } : undefined,
    }
  }
}

/** ZCode 基线能力面（t7 起可被 capabilitiesOverride 按声明收窄）。 */
export const ZCODE_BASE_CAPABILITIES: ExecutorCapabilities = {
  liveOutput: true,
  sessionReuse: true,
  sessionResume: true,
  modelSelection: true,
  providerSelection: true,
  thoughtControl: true,
  thoughtLevels: ['off', 'low', 'medium', 'high', 'max'],
  modeControl: true,
  modes: ['build', 'plan', 'edit', 'ask', 'yolo'],
  tools: {
    externalRuntime: true,
    filtering: 'none',
    permission: 'reject',
  },
}

/**
 * t7：providers.json 动态 provider 的统一包装。
 * 能力面由调用方按 declaredExtensions 推导（zcode 命中才声明模型/思考/模式控制）。
 */
export function createStoredAcpExecutorProvider(
  provider: AcpSessionProvider,
  capabilitiesOverride?: Partial<ExecutorCapabilities>,
): ZcodeAcpExecutorProvider {
  return new ZcodeAcpExecutorProvider(provider, {
    executorIds: [provider.name],
    ...(capabilitiesOverride !== undefined ? { capabilitiesOverride } : {}),
  })
}
