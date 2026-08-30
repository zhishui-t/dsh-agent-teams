import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { parse as parseYaml } from 'yaml'

import { WeaveError } from './weave-error.js'

/**
 * t7 —— 动态 ACP Provider 配置存储（~/.dsh/weave/providers.json）与入参解析。
 *
 * - 配置是真实持久化文件；add/remove 立即写盘，注册后无需重启即可出现在执行器列表。
 * - 入参支持两种形态：JSON 对象/字符串优先；其次紧凑 key=value 串。
 * - 校验失败一律抛 WeaveError('invalid_argument')，绝不静默修正。
 */

/** providers.json 单条记录。 */
export interface StoredProviderConfig {
  /** 执行器 id；^[a-zA-Z][a-zA-Z0-9_-]{0,63}$。 */
  name: string
  transport: 'stdio'
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  protocol: 'acp'
  /** 声明支持的扩展名；协商时需 ∧ initialize 探测命中。 */
  declaredExtensions?: string[]
  /** ACP 会话创建时挂载的 MCP 服务器配置列表。 */
  mcp_servers?: unknown[]
}

export const PROVIDER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/

const COMPACT_KEYS = ['name', 'transport', 'command', 'args', 'cwd', 'env', 'protocol', 'declaredExtensions', 'mcp_servers'] as const

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new WeaveError('invalid_argument', message, details)
}

/** 校验并归一化一条配置（就地抛 invalid_argument）。 */
export function validateProviderConfig(input: unknown): StoredProviderConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid('provider 配置必须是 JSON 对象')
  }
  const raw = input as Record<string, unknown>

  const name = raw['name']
  if (typeof name !== 'string' || !PROVIDER_NAME_PATTERN.test(name)) {
    invalid(`name 必须匹配 ${PROVIDER_NAME_PATTERN.source}`, { name })
  }
  const transport = raw['transport'] ?? 'stdio'
  if (transport !== 'stdio') {
    invalid("transport 目前仅支持 'stdio'", { transport })
  }
  const protocol = raw['protocol'] ?? 'acp'
  if (protocol !== 'acp') {
    invalid("protocol 目前仅支持 'acp'", { protocol })
  }
  const command = raw['command']
  if (typeof command !== 'string' || command.trim() === '') {
    invalid('command 必须为非空字符串', { command })
  }

  let args: string[] | undefined
  if (raw['args'] !== undefined) {
    if (!Array.isArray(raw['args']) || raw['args'].some((item) => typeof item !== 'string' || item === '')) {
      invalid('args 必须为非空字符串数组', { args: raw['args'] })
    }
    args = raw['args'] as string[]
  }

  let cwd: string | undefined
  if (raw['cwd'] !== undefined) {
    if (typeof raw['cwd'] !== 'string' || raw['cwd'].trim() === '') {
      invalid('cwd 必须为非空字符串', { cwd: raw['cwd'] })
    }
    cwd = raw['cwd']
  }

  let env: Record<string, string> | undefined
  if (raw['env'] !== undefined) {
    env = normalizeEnv(raw['env'])
  }

  let declaredExtensions: string[] | undefined
  if (raw['declaredExtensions'] !== undefined) {
    if (
      !Array.isArray(raw['declaredExtensions']) ||
      raw['declaredExtensions'].some((item) => typeof item !== 'string' || item.trim() === '')
    ) {
      invalid('declaredExtensions 必须为非空字符串数组', { declaredExtensions: raw['declaredExtensions'] })
    }
    declaredExtensions = raw['declaredExtensions'] as string[]
  }

  const config: StoredProviderConfig = {
    name,
    transport: 'stdio',
    command,
    protocol: 'acp',
  }
  if (args !== undefined) config.args = args
  if (cwd !== undefined) config.cwd = cwd
  if (env !== undefined) config.env = env
  if (declaredExtensions !== undefined) config.declaredExtensions = declaredExtensions
  if (raw['mcp_servers'] !== undefined) {
    if (!Array.isArray(raw['mcp_servers'])) invalid('mcp_servers 必须是数组', { mcp_servers: raw['mcp_servers'] })
    config.mcp_servers = raw['mcp_servers'] as unknown[]
  }
  return config
}

/** 归一化 env：兼容 `{K:V}` 与 ACP 常见的 `[{name,value}]`。 */
function normalizeEnv(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const env: Record<string, string> = {}
    for (const item of value) {
      if (typeof item !== 'object' || item === null) {
        invalid('env 数组每项必须是 {name,value} 对象', { item })
      }
      const row = item as Record<string, unknown>
      const name = row['name']
      const envValue = row['value']
      if (typeof name !== 'string' || name === '' || typeof envValue !== 'string') {
        invalid('env 数组每项必须含非空 name 与字符串 value', { item })
      }
      env[name] = envValue
    }
    return env
  }
  if (typeof value !== 'object' || value === null) {
    invalid('env 必须为 string→string 对象', { env: value })
  }
  const env: Record<string, string> = {}
  for (const [key, envValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof envValue !== 'string') {
      invalid(`env.${key} 必须为字符串`, { value: envValue })
    }
    env[key] = envValue
  }
  return env
}

/** 粗略判断一段文本更像 YAML 而不是紧凑 key=value。 */
function looksLikeYaml(text: string): boolean {
  return /(^|\n)\s*[A-Za-z_][\w.-]*\s*:(\s|$)/.test(text) || /^---\s*$/.test(text.trim())
}

/** 从非结构化协议文本中尽力提取 name/command/args/env/extensions 等字段。 */
function tryExtractProviderText(text: string): Record<string, unknown> | undefined {
  const record: Record<string, unknown> = {}
  const env: Record<string, string> = {}
  let currentListKey: string | undefined
  let inEnv = false
  // 兼容换行被斜杠命令压成单行的情况：在下一个已知字段前插入换行。
  const normalized = text.replace(
    /\s(?=(?:name|id|command|args|cwd|env|protocol|transport|declaredExtensions|extensions)\s*[:=])/g,
    '\n',
  )
  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const listItem = line.match(/^-\s+(.+)$/)
    if (listItem && currentListKey) {
      const arr = (record[currentListKey] as string[] | undefined) ?? []
      arr.push(listItem[1]!.trim())
      record[currentListKey] = arr
      continue
    }
    const kv = line.match(/^([A-Za-z_][\w.-]*)\s*[:=]\s*(.*)$/)
    if (!kv) {
      if (inEnv) {
        const envKv = line.match(/^([A-Za-z_][\w.-]*)\s*[:=]\s*(.*)$/)
        if (envKv) env[envKv[1]!] = envKv[2]!.trim()
      }
      continue
    }
    const key = kv[1]!
    const value = kv[2]!.trim()
    currentListKey = undefined
    inEnv = false
    if (key === 'env') {
      inEnv = true
      if (value) {
        if (value.startsWith('{') && value.endsWith('}')) {
          try {
            const parsed = JSON.parse(value) as Record<string, unknown>
            if (parsed && typeof parsed === 'object') {
              for (const [envKey, envValue] of Object.entries(parsed)) env[envKey] = String(envValue)
            }
          } catch {
            // ignore inline object parse failure
          }
        } else {
          for (const pair of value.split(',')) {
            const eq = pair.indexOf('=')
            if (eq > 0) env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
          }
        }
        record.env = { ...env }
      }
      continue
    }
    if (key === 'args' || key === 'extensions' || key === 'declaredExtensions') {
      if (!value) {
        currentListKey = key
        record[key] = []
      } else {
        record[key] = value.split(/[\s,]+/).filter(Boolean)
      }
      continue
    }
    if (['name', 'id', 'command', 'cwd', 'protocol', 'transport'].includes(key)) {
      record[key] = value
    }
  }
  if (Object.keys(env).length > 0) record.env = { ...env }
  if (!record.name && record.id) record.name = record.id
  if (typeof record.name !== 'string' || typeof record.command !== 'string') return undefined
  return record
}

/** 解析多 provider 输入：单对象、JSON 数组、或 `{providers|servers|mcpServers:[]}`，也支持 YAML/文件路径。 */
export function parseProviderInputs(raw: string | unknown): StoredProviderConfig[] {
  if (typeof raw !== 'string') {
    return normalizeProviderCandidates(raw)
  }
  const rawTrimmed = raw.trim()
  const prefixMatch = rawTrimmed.match(/^(?:provider\s+)?add\s+([\s\S]*)$/i)
  const trimmed = (prefixMatch?.[1] ?? rawTrimmed).trim()
  if (trimmed === '') invalid('provider 配置不能为空')
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      invalid(`JSON 解析失败: ${String(error)}`)
    }
    return normalizeProviderCandidates(parsed)
  }
  const fenceMatch = trimmed.match(/```(?:json|yaml|yml)?\s*\n([\s\S]*?)\n```/)
  if (fenceMatch?.[1]) {
    return parseProviderInputs(fenceMatch[1].trim())
  }
  if (existsSync(trimmed)) {
    const content = readFileSync(trimmed, 'utf8')
    return parseProviderInputs(content)
  }
  const yamlCandidate = looksLikeYaml(trimmed)
  if (yamlCandidate) {
    let parsed: unknown
    try {
      parsed = parseYaml(trimmed)
    } catch {
      parsed = undefined
    }
    if (parsed !== undefined && parsed !== null) {
      return normalizeProviderCandidates(parsed)
    }
  }
  const extracted = tryExtractProviderText(trimmed)
  if (extracted) {
    return [parseProviderInput(normalizeProviderRecord(extracted))]
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || /^\.{0,2}[\\/]/.test(trimmed) || /^@/.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    invalid(`文件不存在或无法读取: ${trimmed}`)
  }
  return [parseProviderInput(trimmed)]
}

/** 把顶层候选归一化为若干条 provider 配置。 */
function normalizeProviderCandidates(input: unknown): StoredProviderConfig[] {
  if (Array.isArray(input)) {
    if (input.length === 0) invalid('provider 配置数组不能为空')
    return input.map((item) => parseProviderInput(item as never))
  }
  if (typeof input !== 'object' || input === null) {
    invalid('provider 配置必须是 JSON 对象或数组')
  }
  const record = input as Record<string, unknown>
  const listKey = (['providers', 'servers', 'mcpServers'] as const).find((key) => {
    const value = record[key]
    return Array.isArray(value) || (typeof value === 'object' && value !== null)
  })
  if (listKey) {
    const container = record[listKey]
    let list: unknown[]
    if (Array.isArray(container)) {
      list = container
    } else if (typeof container === 'object' && container !== null) {
      list = Object.entries(container as Record<string, unknown>).map(([name, item]) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          return { name, ...(item as Record<string, unknown>) }
        }
        return item
      })
    } else {
      invalid(`${listKey} 必须是数组或对象`)
    }
    if (list.length === 0) invalid(`${listKey} 不能为空`)
    return list.map((item) => {
      if (typeof item === 'string') return parseProviderInput(item)
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        invalid(`${listKey} 每一项必须是对象`)
      }
      const entry = { ...(item as Record<string, unknown>) }
      if (entry.transport === undefined) entry.transport = 'stdio'
      if (entry.protocol === undefined) entry.protocol = 'acp'
      if ((entry.name === undefined || entry.name === '') && typeof entry.id === 'string' && entry.id !== '') {
        entry.name = entry.id
      }
      if (entry.declaredExtensions === undefined && Array.isArray(entry.extensions)) {
        entry.declaredExtensions = entry.extensions
      }
      if (typeof entry.args === 'string') {
        entry.args = entry.args.split(/[\s,]+/).filter((item: string) => item !== '')
      }
      return parseProviderInput(entry as Record<string, unknown>)
    })
  }
  return [parseProviderInput(normalizeProviderRecord(record))]
}

/**
 * 解析命令行原始输入：JSON 优先（对象或以 '{' 开头的字符串），
 * 其次紧凑 key=value（空白分词；args/declaredExtensions 逗号分隔；
 * env 形如 A=1,B=2，每项按第一个 '=' 切分）。未知键直接拒绝。
 */
/** 归一化单条 provider 记录：补默认值、兼容 id/extensions/args 字符串等 ACP 常见写法。 */
function normalizeProviderRecord(record: Record<string, unknown>): Record<string, unknown> {
  const entry = { ...record }
  if (entry.transport === undefined) entry.transport = 'stdio'
  if (entry.protocol === undefined) entry.protocol = 'acp'
  if ((entry.name === undefined || entry.name === '') && typeof entry.id === 'string' && entry.id !== '') {
    entry.name = entry.id
  }
  if (entry.declaredExtensions === undefined && Array.isArray(entry.extensions)) {
    entry.declaredExtensions = entry.extensions
  }
  if (typeof entry.args === 'string') {
    entry.args = entry.args.split(/[\s,]+/).filter((item: string) => item !== '')
  }
  return entry
}

export function parseProviderInput(raw: string | Record<string, unknown>): StoredProviderConfig {
  if (typeof raw !== 'string') {
    return validateProviderConfig(raw)
  }
  const trimmed = raw.trim()
  if (trimmed === '') invalid('provider 配置不能为空')
  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      invalid(`JSON 解析失败: ${String(error)}`)
    }
    return validateProviderConfig(parsed)
  }

  const record: Record<string, unknown> = {}
  for (const token of trimmed.split(/\s+/)) {
    const eq = token.indexOf('=')
    if (eq <= 0) invalid(`紧凑配置段必须是 key=value 形式: ${token}`, { token })
    const key = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (!(COMPACT_KEYS as readonly string[]).includes(key)) {
      invalid(`未知配置字段: ${key}`, { field: key, allowed: COMPACT_KEYS })
    }
    if (key === 'args' || key === 'declaredExtensions') {
      record[key] = value === '' ? [] : value.split(',').filter((item) => item !== '')
    } else if (key === 'env') {
      const env: Record<string, string> = {}
      if (value !== '') {
        for (const pair of value.split(',')) {
          const sep = pair.indexOf('=')
          if (sep <= 0) invalid(`env 段必须是 KEY=VALUE 形式: ${pair}`, { pair })
          env[pair.slice(0, sep)] = pair.slice(sep + 1)
        }
      }
      record[key] = env
    } else {
      record[key] = value
    }
  }
  return validateProviderConfig(record)
}

export interface ProviderStoreOptions {
  /** 覆盖默认路径（测试注入临时目录）。 */
  file?: string
}

export const DEFAULT_PROVIDERS_FILE = join(homedir(), '.dsh', 'weave', 'providers.json')

/** providers.json 的读改写门面；所有变更立即落盘。 */
export class ProviderStore {
  readonly file: string

  constructor(options: ProviderStoreOptions = {}) {
    this.file = options.file ?? DEFAULT_PROVIDERS_FILE
  }

  list(): StoredProviderConfig[] {
    if (!readSafe(this.file)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
      const providers = (parsed as { providers?: unknown }).providers
      if (!Array.isArray(providers)) return []
      return providers.filter(
        (item): item is StoredProviderConfig =>
          typeof item === 'object' && item !== null && typeof (item as StoredProviderConfig).name === 'string',
      )
    } catch {
      // 损坏文件视为空库（不阻断启动）；下次 add 会重写合法结构。
      return []
    }
  }

  get(name: string): StoredProviderConfig | undefined {
    return this.list().find((item) => item.name === name)
  }

  add(config: StoredProviderConfig): StoredProviderConfig {
    const normalized = validateProviderConfig(config)
    const providers = this.list().filter((item) => item.name !== normalized.name)
    providers.push(normalized)
    this.#write(providers)
    return normalized
  }

  remove(name: string): boolean {
    const providers = this.list()
    const next = providers.filter((item) => item.name !== name)
    if (next.length === providers.length) return false
    this.#write(next)
    return true
  }

  #write(providers: StoredProviderConfig[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify({ version: 1, providers }, null, 2)}\n`, 'utf8')
  }
}

function readSafe(file: string): boolean {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}

/** 测试辅助：清掉临时文件。 */
export function removeProviderFile(file: string): void {
  rmSync(file, { force: true })
}
