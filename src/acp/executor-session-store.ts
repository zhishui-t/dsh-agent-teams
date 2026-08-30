import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface ExecutorSessionRecord {
  /** Backend agent identifier: 'zcode' or future custom agents. */
  type: string
  acpSid: string
  updatedAt: number
}

export interface SessionKeyInput {
  workspace: string
  teamId: string
  roleId: string
}

export interface ExecutorSessionIndexFile {
  version: 2
  keys: Record<string, ExecutorSessionRecord>
}

export const DEFAULT_ACP_SESSION_INDEX_FILE = joinHome('.dsh', 'weave', 'acp-session-index.json')

function joinHome(...parts: string[]): string {
  return resolve(homedir(), ...parts)
}

/**
 * Session-key → ACP alias index for member transport.
 *
 * v2 schema: every new record carries a `type` (backend agent), no cwd, and no
 * dependency on zcode internal ids. Old v1 records without type are accepted
 * for reads and normalized as `zcode`.
 */
export class ExecutorSessionStore {
  readonly #file: string
  readonly #fingerprints = new Map<string, string>()

  constructor(file: string = DEFAULT_ACP_SESSION_INDEX_FILE) {
    this.#file = file
  }

  sessionKeyOf(input: SessionKeyInput): string {
    const fingerprint = this.#workspaceFingerprint(input.workspace)
    return `${fingerprint}:${input.teamId}:${input.roleId}`
  }

  resolve(sessionKey: string): { resumeSessionId?: string } | null {
    const record = this.#read().keys[sessionKey]
    if (!record || record.acpSid === '') return null
    return { resumeSessionId: record.acpSid }
  }

  remember(sessionKey: string, record: ExecutorSessionRecord): void {
    const index = this.#read()
    index.keys[sessionKey] = {
      type: record.type,
      acpSid: record.acpSid,
      updatedAt: record.updatedAt ?? Date.now(),
    }
    this.#write(index)
  }

  #read(): ExecutorSessionIndexFile {
    try {
      if (!existsSync(this.#file)) return { version: 2, keys: {} }
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<ExecutorSessionIndexFile>
      const keys: Record<string, ExecutorSessionRecord> = {}
      if (raw && typeof raw === 'object' && raw.keys && typeof raw.keys === 'object') {
        for (const [key, value] of Object.entries(raw.keys as Record<string, Partial<ExecutorSessionRecord>>)) {
          if (key === '' || !value || typeof value.acpSid !== 'string' || value.acpSid === '') continue
          keys[key] = {
            type: typeof value.type === 'string' && value.type !== '' ? value.type : 'zcode',
            acpSid: value.acpSid,
            updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
          }
        }
      }
      return { version: 2, keys }
    } catch {
      return { version: 2, keys: {} }
    }
  }

  #write(index: ExecutorSessionIndexFile): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(this.#file, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    } catch {
      // Best-effort: persistent index failure must not block dispatch.
    }
  }

  #workspaceFingerprint(workspace: string): string {
    const normalized = resolve(workspace)
    const cached = this.#fingerprints.get(normalized)
    if (cached !== undefined) return cached
    const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 16)
    this.#fingerprints.set(normalized, hash)
    return hash
  }
}
