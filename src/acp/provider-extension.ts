import type { AcpAgentCapabilities, AcpAgentInfo, AcpSessionUpdate } from './acp-session-provider.js'
import type { ExecutorEvent } from './executor-provider.js'

/**
 * t7 —— 通用 ACP Provider 扩展框架。
 *
 * 职责边界：
 * - 探测协商：从 initialize 响应三源（agentInfo / agentCapabilities._meta / _meta）
 *   识别 provider 声明的扩展；**必须同时满足「配置已声明」且「探测命中」才激活**，
 *   其余情况一律降级并在报告中给出原因（未知名 / 探测失败 / 探测异常 / 探测到但未声明）。
 * - 能力映射：每个扩展声明是否支持 model/thought/mode/toolFiltering/sessionResume；
 *   Weave 运行时意图只映射给声明了对应能力的激活扩展。
 * - 运行时应用：apply() 把意图翻译为标准调用或 extMethod；失败必须降级为
 *   { supported:false, fallback:true, detail }，不得让执行主链路中断。
 * - 方法白名单：extMethod 只允许调用 allowedMethods 中声明过的方法。
 * - update 变换：可选 transformUpdate 把 provider-specific update 转 WeaveExecutorEvent；
 *   未实现或缺省时由协议内核默认转换。
 *
 * 本模块只做类型反向依赖（import type）acp-session-provider，运行时无循环。
 */

/** Weave 统一执行器事件（别名，语义对齐架构文档中的 WeaveExecutorEvent）。 */
export type WeaveExecutorEvent = ExecutorEvent

/** 扩展探测输入：initialize 返回的三个识别源。 */
export interface AcpExtensionProbeInput {
  agentInfo?: AcpAgentInfo
  agentCapabilities?: AcpAgentCapabilities
  /** initialize 响应顶层 _meta。 */
  meta?: unknown
}

/** 扩展能力声明（供 capability mapping 与 unsupported 报告使用）。 */
export interface AcpCapabilityDeclaration {
  model: boolean
  thought: boolean
  mode: boolean
  toolFiltering: boolean
  sessionResume: boolean
}

/** 单项能力的应用结果：requested/effective/supported/fallback 必须可观测。 */
export interface AcpCapabilityApplication {
  requested?: unknown
  effective?: unknown
  supported: boolean
  fallback?: boolean
  /** 降级/失败原因（可观测性要求）。 */
  detail?: string
}

/** Weave 运行时意图（来自 ExecutorStartRequest.runtime 的标准化形状）。 */
export interface AcpRuntimeIntent {
  sessionId: string
  modelProvider?: string
  model?: string
  thoughtLevel?: string
  mode?: string
  /** 工具策略（ExecutorToolsPolicy 结构）；框架 v1 不支持过滤，恒报告 unsupported。 */
  tools?: unknown
}

/** 扩展可用的最小连接面（仅白名单放行的 extMethod）。 */
export interface AcpExtensionCallContext {
  extMethod(method: string, params: Record<string, unknown>): Promise<unknown>
}

export type AcpIntentKey = 'model' | 'thought' | 'mode' | 'tools'

/**
 * ACP Provider 扩展插口。
 * detect/init 与 capability mapping 为必选；runtime apply 处理三类意图；
 * transformUpdate 可选（session update transform）。
 */
export interface AcpProviderExtension {
  /** 扩展注册名（如 'zcode'）。 */
  readonly name: string
  /** 允许调用的 extension 方法白名单。 */
  readonly allowedMethods: readonly string[]
  readonly capabilities: AcpCapabilityDeclaration
  /** 从 initialize 三源识别扩展是否存在；抛异常视为探测失败并降级。 */
  detect(input: AcpExtensionProbeInput): boolean
  /**
   * 将意图映射为标准调用或 extMethod；返回各意图的应用结果。
   * 实现必须捕获自身 extMethod 异常并降级为 supported:false，不向外抛。
   */
  apply(
    intent: AcpRuntimeIntent,
    ctx: AcpExtensionCallContext,
  ): Promise<Partial<Record<'model' | 'thought' | 'mode', AcpCapabilityApplication>>>
  /**
   * provider-specific update → WeaveExecutorEvent（不含 at 时间戳）。
   * 返回 undefined/空数组表示本扩展不处理，交回内核默认转换。
   */
  transformUpdate?(update: AcpSessionUpdate): Array<Omit<WeaveExecutorEvent, 'at'>> | undefined
}

/** 白名单放行：只允许调用扩展声明过的方法。 */
export async function callExtensionMethod(
  extension: AcpProviderExtension,
  ctx: AcpExtensionCallContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!extension.allowedMethods.includes(method)) {
    throw new Error(`extension "${extension.name}" 未声明方法 ${method}（allowlist 拒绝）`)
  }
  return ctx.extMethod(method, params)
}

function looksLikeZcode(value: unknown): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes('zcode')
  if (typeof value !== 'object' || value === null) return false
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key.toLowerCase().includes('zcode')) return true
  }
  return false
}

/**
 * 内置第一个扩展：zcode——封装 ZCode ACP 的 model/thought/mode 扩展方法，
 * 并按真实协议放行统一配置入口 session/set_config_option 与
 * session/updateRuntimeModelConfig（与协议内核解耦，可被通用 provider 复用）。
 */
export function createZcodeExtension(): AcpProviderExtension {
  const ZCODE_METHODS = [
    'session/setModel',
    'session/setThoughtLevel',
    'session/setMode',
    'session/set_config_option',
    'session/updateRuntimeModelConfig',
  ] as const
  return {
    name: 'zcode',
    allowedMethods: ZCODE_METHODS,
    capabilities: { model: true, thought: true, mode: true, toolFiltering: false, sessionResume: false },
    detect(input) {
      const haystacks: unknown[] = [
        input.meta,
        input.agentCapabilities?._meta,
        (input.agentInfo as unknown as { _meta?: unknown } | undefined)?._meta,
        input.agentInfo?.name,
        input.agentInfo?.title,
      ]
      return haystacks.some((item) => looksLikeZcode(item))
    },
    async apply(intent, ctx) {
      const out: Partial<Record<'model' | 'thought' | 'mode', AcpCapabilityApplication>> = {}

      if (intent.model !== undefined || intent.modelProvider !== undefined) {
        const requested = { provider: intent.modelProvider, id: intent.model }
        if (!intent.model) {
          out.model = {
            requested,
            supported: false,
            fallback: true,
            detail: 'model id 缺失，无法构造 provider/model 取值',
          }
        } else {
          // 与既有约定一致：多 provider 场景用 "provider\model" 反斜杠拼接。
          const effective = intent.modelProvider
            ? `${intent.modelProvider}\\${intent.model}`
            : intent.model
          try {
            await callExtensionMethod(this, ctx, 'session/setModel', { sessionId: intent.sessionId, modelId: effective })
            out.model = { requested, effective, supported: true }
          } catch (error) {
            out.model = { requested, supported: false, fallback: true, detail: String(error) }
          }
        }
      }

      if (intent.thoughtLevel !== undefined) {
        try {
          await callExtensionMethod(this, ctx, 'session/setThoughtLevel', {
            sessionId: intent.sessionId,
            thoughtLevel: intent.thoughtLevel,
          })
          out.thought = { requested: intent.thoughtLevel, effective: intent.thoughtLevel, supported: true }
        } catch (error) {
          out.thought = { requested: intent.thoughtLevel, supported: false, fallback: true, detail: String(error) }
        }
      }

      if (intent.mode !== undefined) {
        try {
          await callExtensionMethod(this, ctx, 'session/setMode', { sessionId: intent.sessionId, mode: intent.mode })
          out.mode = { requested: intent.mode, effective: intent.mode, supported: true }
        } catch (error) {
          out.mode = { requested: intent.mode, supported: false, fallback: true, detail: String(error) }
        }
      }

      return out
    },
  }
}

/** 内置扩展注册表：新扩展在此登记后即可被 declaredExtensions 引用。 */
export const BUILTIN_ACP_EXTENSIONS: Readonly<Record<string, AcpProviderExtension>> = {
  zcode: createZcodeExtension(),
}

export type ExtensionNegotiationStatus = 'active' | 'inactive'

export interface ExtensionNegotiationEntry {
  name: string
  status: ExtensionNegotiationStatus
  /** inactive 时给出降级原因：unknown-extension / detect-error / not-detected / detected-but-not-declared。 */
  reason?: string
}

export interface ExtensionNegotiation {
  active: AcpProviderExtension[]
  report: ExtensionNegotiationEntry[]
}

/**
 * 扩展协商：activation = 配置已声明 ∧ initialize 探测命中。
 * 任一条件不满足即降级，且降级原因逐条可观测。
 */
export function negotiateExtensions(
  declaredNames: readonly string[],
  registry: Readonly<Record<string, AcpProviderExtension>>,
  probe: AcpExtensionProbeInput,
): ExtensionNegotiation {
  const active: AcpProviderExtension[] = []
  const report: ExtensionNegotiationEntry[] = []

  for (const name of declaredNames) {
    const extension = registry[name]
    if (!extension) {
      report.push({ name, status: 'inactive', reason: 'unknown-extension' })
      continue
    }
    let detected = false
    let detectError: string | undefined
    try {
      detected = extension.detect(probe)
    } catch (error) {
      detectError = String(error)
    }
    if (detectError !== undefined) {
      report.push({ name, status: 'inactive', reason: `detect-error: ${detectError}` })
      continue
    }
    if (!detected) {
      report.push({ name, status: 'inactive', reason: 'not-detected' })
      continue
    }
    active.push(extension)
    report.push({ name, status: 'active' })
  }

  // 探测到但未声明：保守不放行（避免误用未经配置审查的方法白名单）。
  for (const extension of Object.values(registry)) {
    if (declaredNames.includes(extension.name)) continue
    let detected = false
    try {
      detected = extension.detect(probe)
    } catch {
      detected = false
    }
    if (detected) {
      report.push({ name: extension.name, status: 'inactive', reason: 'detected-but-not-declared' })
    }
  }

  return { active, report }
}

/**
 * 把 Weave 运行时意图应用到激活扩展集合：
 * - 每类意图路由给第一个声明支持它的激活扩展；
 * - 无扩展支持 → { supported:false, fallback:true, detail } 明确降级；
 * - tools 过滤框架 v1 不支持，恒报告 unsupported+fallback（可观测）。
 * 返回值只包含请求过的意图键。
 */
export async function applyRuntimeIntents(
  active: readonly AcpProviderExtension[],
  intent: Omit<AcpRuntimeIntent, 'sessionId'> & { sessionId: string },
  ctx: AcpExtensionCallContext,
): Promise<{ applied: Partial<Record<AcpIntentKey, AcpCapabilityApplication>> }> {
  const applied: Partial<Record<AcpIntentKey, AcpCapabilityApplication>> = {}
  const wants = {
    model: intent.model !== undefined || intent.modelProvider !== undefined,
    thought: intent.thoughtLevel !== undefined,
    mode: intent.mode !== undefined,
    tools: intent.tools !== undefined,
  }

  if (!wants.model && !wants.thought && !wants.mode && !wants.tools) {
    return { applied }
  }

  if (active.length === 0) {
    const detail = 'no active extension (negotiation produced none)'
    if (wants.model) applied.model = { requested: { provider: intent.modelProvider, id: intent.model }, supported: false, fallback: true, detail }
    if (wants.thought) applied.thought = { requested: intent.thoughtLevel, supported: false, fallback: true, detail }
    if (wants.mode) applied.mode = { requested: intent.mode, supported: false, fallback: true, detail }
    if (wants.tools) applied.tools = { requested: intent.tools, supported: false, fallback: true, detail }
    return { applied }
  }

  const route = (key: 'model' | 'thought' | 'mode'): AcpProviderExtension | undefined =>
    active.find((extension) => extension.capabilities[key])

  const runFor = async (
    key: 'model' | 'thought' | 'mode',
    requested: unknown,
  ): Promise<void> => {
    const extension = route(key)
    if (!extension) {
      applied[key] = { requested, supported: false, fallback: true, detail: `no active extension declares ${key}` }
      return
    }
    try {
      const partial = await extension.apply(intent, ctx)
      const result = partial[key]
      if (result) {
        applied[key] = result
        return
      }
      applied[key] = {
        requested,
        supported: false,
        fallback: true,
        detail: `extension "${extension.name}" returned no ${key} application`,
      }
    } catch (error) {
      applied[key] = { requested, supported: false, fallback: true, detail: `extension apply failed: ${String(error)}` }
    }
  }

  if (wants.model) await runFor('model', { provider: intent.modelProvider, id: intent.model })
  if (wants.thought) await runFor('thought', intent.thoughtLevel)
  if (wants.mode) await runFor('mode', intent.mode)

  if (wants.tools) {
    applied.tools = {
      requested: intent.tools,
      supported: false,
      fallback: true,
      detail: 'tool filtering not supported by any active extension',
    }
  }

  return { applied }
}
