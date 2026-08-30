import {
  AcpSessionProvider,
  DEFAULT_ACP_SESSION_INDEX_FILE,
  createStoredAcpExecutorProvider,
  ZcodeAcpExecutorProvider,
  type AcpSessionProviderConfig,
} from './acp-session-provider.js'
import { ProviderStore, parseProviderInputs, type StoredProviderConfig } from './provider-store.js'
import type { ExecutorCapabilities } from './executor-provider.js'

/**
 * t7 —— 动态 ACP Provider 纯 API 模块（文件所有权：t7，仅 acp/**）。
 *
 * 本模块不触碰 index.ts / rpc.ts / 会话编排；宿主集成（挂载命令、启动加载）
 * 由后续集成任务调用这里的纯 API 完成：
 * - loadProviderConfigs()：读取 providers.json 全部配置；
 * - createAcpProviderFromConfig(config, spawn)：配置 → { acp, wrapper } 执行器栈；
 * - registerStoredAcpProviders(...)：批量热注册到当前会话（subagents/subprocess 由调用方注入）；
 * - createWeaveProviderCommandDefinitions(...)：/weave provider add/list/remove
 *   的命令定义（结构兼容 dsh-commands CommandDefinition），由集成方统一挂载。
 */

/** 未声明 zcode 扩展时的真实能力基线（不虚报模型/思考/模式控制）。 */
export const DYNAMIC_BASELINE_CAPABILITIES: ExecutorCapabilities = {
  liveOutput: true,
  sessionReuse: true,
  sessionResume: false,
  modelSelection: false,
  providerSelection: false,
  thoughtControl: false,
  thoughtLevels: [],
  modeControl: false,
  modes: [],
  tools: { externalRuntime: true, filtering: 'none', permission: 'reject' },
}

/** 声明了 zcode 扩展 → 沿用 ZCode 全量能力面；否则按真实基线收窄。 */
export function dynamicCapabilitiesFor(declaredExtensions?: string[]): Partial<ExecutorCapabilities> | undefined {
  return declaredExtensions?.includes('zcode') ? undefined : DYNAMIC_BASELINE_CAPABILITIES
}

export interface DynamicAcpStack {
  acp: AcpSessionProvider
  wrapper: ZcodeAcpExecutorProvider
}

export type AcpSpawnFn = (spec: {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'inherit' | 'ignore' | 'pipe' }
  graceMs?: number
}) => unknown

/** 配置 → 可执行栈：会话级 ACP provider + 统一 ExecutorProvider 包装。 */
export function createAcpProviderFromConfig(config: StoredProviderConfig, spawn: AcpSpawnFn): DynamicAcpStack {
  const acpConfig: AcpSessionProviderConfig = {
    name: config.name,
    command: config.command,
    ...(config.args !== undefined ? { args: config.args } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.env !== undefined ? { env: config.env } : {}),
    permission: 'reject',
    ...(config.mcp_servers !== undefined ? { mcpServers: config.mcp_servers } : {}),
    ...(config.declaredExtensions !== undefined ? { declaredExtensions: config.declaredExtensions } : {}),
    // iso-1：动态 provider 同样启用 sessionKey→acpSid 持久索引（默认路径集中管理）。
    sessionIndexFile: DEFAULT_ACP_SESSION_INDEX_FILE,
  }
  const acp = new AcpSessionProvider(acpConfig, spawn as never)
  return {
    acp,
    wrapper: createStoredAcpExecutorProvider(acp, dynamicCapabilitiesFor(config.declaredExtensions)),
  }
}

export interface LoadProviderConfigsOptions {
  /** 覆盖默认 ~/.dsh/weave/providers.json（测试注入临时目录）。 */
  providersFile?: string
}

/** 读取全部动态 provider 配置（默认路径；文件缺失/损坏返回 []）。 */
export function loadProviderConfigs(options: LoadProviderConfigsOptions = {}): StoredProviderConfig[] {
  return new ProviderStore({ file: options.providersFile }).list()
}

export interface RegisterStoredAcpProvidersOptions extends LoadProviderConfigsOptions {
  /** 等价 ctx.subagents（仅需 registerProvider）；缺失时全部跳过并报告原因。 */
  subagents?: { registerProvider?(provider: unknown): () => void }
  /** 等价 ctx.subprocess.spawn。 */
  subprocess?: { spawn(spec: Parameters<AcpSpawnFn>[0]): unknown }
  /** 可选：同时注册进 ExecutorProviderRegistry（能力面已按声明收窄）。 */
  registry?: { register(provider: ZcodeAcpExecutorProvider, options?: { override?: boolean }): () => void }
  /** 仅注册指定名字；缺省全部。 */
  names?: readonly string[]
}

export interface RegisterStoredAcpProvidersResult {
  registered: string[]
  failed: Array<{ name: string; error: string }>
  /** 全部 disposer 的聚合视图，便于插件一次性卸载。 */
  disposers: Array<() => void>
  /** 按 provider 名隔离的 disposer，供 remove 精确注销。 */
  disposersByName: Record<string, Array<() => void>>
}

/**
 * 把 providers.json（或其子集）热注册到当前会话；无需重启即可出现在执行器列表。
 * 不抛异常：单个 provider 失败记入 failed，其余继续。
 */
export function registerStoredAcpProviders(
  options: RegisterStoredAcpProvidersOptions = {},
): RegisterStoredAcpProvidersResult {
  const result: RegisterStoredAcpProvidersResult = { registered: [], failed: [], disposers: [], disposersByName: {} }
  if (!options.subagents || !options.subprocess) {
    result.failed.push({
      name: '*',
      error: 'subagents/subprocess 服务不可用；配置保持持久化，重启会话后生效',
    })
    return result
  }
  const configs = loadProviderConfigs(options).filter(
    (cfg) => options.names === undefined || options.names.includes(cfg.name),
  )
  for (const cfg of configs) {
    try {
      const stack = createAcpProviderFromConfig(cfg, (spec) => options.subprocess!.spawn(spec) as never)
      const namedDisposers: Array<() => void> = []
      const subagentsDisposer = options.subagents.registerProvider?.(stack.acp)
      if (subagentsDisposer) namedDisposers.push(subagentsDisposer)
      try {
        const registryDisposer = options.registry?.register(stack.wrapper, { override: true })
        if (registryDisposer) namedDisposers.push(registryDisposer)
      } catch (error) {
        for (const dispose of namedDisposers.reverse()) dispose()
        throw error
      }
      result.disposers.push(...namedDisposers)
      result.disposersByName[cfg.name] = namedDisposers
      result.registered.push(cfg.name)
    } catch (error) {
      result.failed.push({ name: cfg.name, error: String(error) })
    }
  }
  return result
}

/* --------------------- /weave provider add/list/remove 命令定义 --------------------- */

export interface WeaveProviderCommandDefinition {
  name: string
  description: string
  input: { hint: string }
  handler(rawInput: string): Promise<{ kind: 'success' | 'error'; text: string }>
}

export interface CreateWeaveProviderCommandDefinitionsOptions extends LoadProviderConfigsOptions {
  /**
   * 热注册实现；缺省用 registerStoredAcpProviders（需运行时注入 subagents/subprocess）。
   * 返回 null 表示成功，字符串为降级说明（配置已持久化）。
   */
  hotRegister?: (cfg: StoredProviderConfig) => Promise<string | null> | string | null
  /** 卸载热注册实例（remove 命令联动时由集成方传入）。 */
  onRemove?: (name: string) => void
}

function invalidText(error: unknown): { kind: 'error'; text: string } {
  const code = (error as { code?: string }).code
  return { kind: 'error', text: error instanceof Error ? `${code ?? 'error'}: ${error.message}` : String(error) }
}

/**
 * 两条会话命令的纯定义（不依赖 Context）：
 * 集成任务拿到后按宿主 CommandDefinition 形状包装 name/description/input/handler 即可挂载。
 */
export function createWeaveProviderCommandDefinitions(
  options: CreateWeaveProviderCommandDefinitionsOptions = {},
): { add: WeaveProviderCommandDefinition; manage: WeaveProviderCommandDefinition } {
  const store = new ProviderStore({ file: options.providersFile })
  const hotRegister = options.hotRegister ?? ((cfg: StoredProviderConfig): string | null => {
    const outcome = registerStoredAcpProviders({ providersFile: options.providersFile, ...(options.onRemove !== undefined ? {} : {}) })
    // 默认实现按名字单注册；失败信息直接透出。
    const failed = outcome.failed.find((f) => f.name === cfg.name)
    return failed ? `热注册失败（配置已持久化）: ${failed.error}` : null
  })

  const add: WeaveProviderCommandDefinition = {
    name: 'provider',
    description:
      '注册一个或多个 ACP 执行器 provider。支持 JSON（单对象/数组/{providers|servers|mcpServers}）、YAML、围栏代码块、文件路径、紧凑 key=value。字段：name、transport=stdio、command、args、cwd、env、protocol=acp、declaredExtensions/extensions。',
    input: {
      hint: 'provider add [{"name":"myagent","transport":"stdio","command":"node","args":["agent.js"],"protocol":"acp","declaredExtensions":["zcode"]}]',
    },
    async handler(rawInput) {
      try {
        const cfgs = parseProviderInputs(rawInput.trim())
        const lines: string[] = []
        for (const cfg of cfgs) {
          store.add(cfg)
          const warn = options.hotRegister ? await options.hotRegister(cfg) : hotRegister(cfg)
          const exts = cfg.declaredExtensions && cfg.declaredExtensions.length > 0 ? cfg.declaredExtensions.join(',') : '无'
          lines.push(`已注册执行器 ${cfg.name}（executor id=${cfg.name}，声明扩展=${exts}）`)
          lines.push(warn ? `提示：${warn}` : `  ${cfg.name} 已在本会话生效。`)
        }
        lines.push(`配置已写入 ${store.file}`)
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return invalidText(error)
      }
    },
  }

  const manage: WeaveProviderCommandDefinition = {
    name: 'provider',
    description: '管理动态 provider：list 列出全部；remove <name> 从配置移除（当前会话已注册实例保持可用，重启后不再加载）。',
    input: { hint: 'provider add <配置> ｜ provider list ｜ provider remove <name>' },
    async handler(rawInput) {
      const argv = rawInput.trim().split(/\s+/).filter((item) => item !== '')
      const command = argv[0] ?? 'list'
      if (command === 'list') {
        const items = store.list()
        if (items.length === 0) return { kind: 'success', text: '（无动态 provider）' }
        return {
          kind: 'success',
          text: items
            .map((c) => `- ${c.name} command=${c.command}${c.args?.length ? ` ${c.args.join(' ')}` : ''} extensions=${c.declaredExtensions?.join(',') ?? '无'}`)
            .join('\n'),
        }
      }
      if (command === 'remove') {
        const name = argv[1] ?? ''
        if (!name) return { kind: 'error', text: '用法: provider remove <name>' }
        const removed = store.remove(name)
        if (!removed) return { kind: 'error', text: `未找到动态 provider: ${name}` }
        options.onRemove?.(name)
        return { kind: 'success', text: `已移除并注销 ${name}` }
      }
      return { kind: 'error', text: `未知子命令: ${command}（可用: list | remove）` }
    },
  }

  return { add, manage }
}

/**
 * 宿主集成辅助：从 cordis ctx 提取 subagents/subprocess 最小面（仅集成任务使用）。
 * 使用结构化类型以避免与宿主不同 node_modules 中的 Context 类型身份冲突。
 */
export interface AcpRegistryContextLike {
  reflect?: { get(key: string, optional?: boolean): unknown }
  subprocess?: { spawn(spec: never): unknown }
}

export function acpRegistryContextFrom(ctx: AcpRegistryContextLike): {
  subagents?: { registerProvider?(provider: unknown): () => void }
  subprocess?: { spawn(spec: Parameters<AcpSpawnFn>[0]): unknown }
} {
  return {
    subagents: ctx.reflect?.get('subagents', false) as
      | { registerProvider?(provider: unknown): () => void }
      | undefined,
    subprocess: ctx.subprocess as { spawn(spec: never): unknown } | undefined as never,
  }
}
