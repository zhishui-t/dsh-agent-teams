import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemberDeliverInput, MemberProvisionInput, MemberTransport } from '../member-transport.js'
import type { TeamMember } from '../types.js'
import type { ExecutorSessionStore } from './executor-session-store.js'

export interface AcpStartRequest {
  sessionKey: string
  resumeSessionId?: string
  prompt: Array<{ type: 'text'; text: string }>
  signal: AbortSignal
  /**
   * ACP 会话的父会话（IPC 契约：`parent.session.header.cwd` 即会话工作目录）。
   * 团队主机经 deliver 传入 workspace（= 队长会话 header.cwd）；不传时
   * AcpSessionProvider 会因缺 cwd 直接 fail fast（zcode: cwd is required）。
   */
  parent?: { session?: { header?: { cwd?: string } } }
  runtime?: unknown
}

export interface AcpRunLike {
  result: Promise<{ output?: Array<{ type?: string; text?: string }>; stopReason?: string }>
  dispose(): Promise<void>
}

export interface AcpTransportProviderLike {
  start(request: AcpStartRequest): Promise<AcpRunLike>
}

export interface AcpDeliverInput {
  captain: unknown
  member: { id: string; name: string; role?: string; executor?: string; provider?: string; model?: string }
  team: { id: string; name: string }
  workspace: string
  prompt: string
  signal?: AbortSignal
  hooks?: {
    onSettled?(outcome: { output: string; failed: boolean; stopReason?: string }): Promise<void>
    onStatusChange?(status: 'idle' | 'working'): void
  }
}

interface ActiveRun {
  controller: AbortController
  run: Promise<AcpRunLike>
}

/**
 * ACP member transport for dsh-agent-teams.
 *
 * Unlike DSH continuable subagents, ACP members do not call agent_teams_*
 * tools. The transport owns one run per member, waits for the result and
 * reports settlement through hooks; the host-side adapter writes task state.
 */
export class AcpMemberTransport implements MemberTransport {
  readonly kind = 'acp'

  readonly #provider: AcpTransportProviderLike
  readonly #store: ExecutorSessionStore
  readonly #active = new Map<string, ActiveRun>()

  constructor(provider: AcpTransportProviderLike, store: ExecutorSessionStore) {
    this.#provider = provider
    this.#store = store
  }

  async provision(input: MemberProvisionInput): Promise<{ memberId: string }> {
    const memberId = `acp:${input.team.id}:${input.member.name}`
    input.member.id = memberId
    return { memberId }
  }

  isAvailable(member: TeamMember): boolean {
    return !this.#active.has(member.id)
  }

  async deliver(input: MemberDeliverInput): Promise<{ accepted: boolean }> {
    const memberId = input.member.id
    if (this.#active.has(memberId)) return { accepted: false }
    const sessionKey = this.#store.sessionKeyOf({
      workspace: input.workspace,
      teamId: input.team.id,
      roleId: input.member.role ?? input.member.name,
    })
    const resumed = this.#store.resolve(sessionKey)
    const controller = new AbortController()
    const signal = input.signal ?? controller.signal
    const runPromise = this.#provider.start({
      sessionKey,
      ...resumed?.resumeSessionId ? { resumeSessionId: resumed.resumeSessionId } : {},
      prompt: [{ type: 'text', text: input.prompt }],
      signal,
      // ACP/zcode 会话创建必需：把主机解析的工作区（队长会话 header.cwd）
      // 作为父会话 cwd 传导，否则新会话无法落盘工作目录而直接抛错。
      parent: { session: { header: { cwd: input.workspace } } },
      runtime: {
        ...input.member.provider && input.member.model
          ? { model: { provider: input.member.provider, id: input.member.model } }
          : {},
      },
    })

    this.#active.set(memberId, { controller, run: runPromise })
    input.hooks?.onStatusChange?.('working')

    void this.#settle(memberId, runPromise, input).catch(() => undefined)
    return { accepted: true }
  }

  interrupt(_ctx: Context, _captain: Agent, member: TeamMember): void {
    const active = this.#active.get(member.id)
    active?.controller.abort()
  }

  async dispose(_ctx: Context, member: TeamMember): Promise<void> {
    const active = this.#active.get(member.id)
    if (!active) return
    active.controller.abort()
    this.#active.delete(member.id)
  }

  async #settle(
    memberId: string,
    runPromise: Promise<AcpRunLike>,
    input: MemberDeliverInput,
  ): Promise<void> {
    try {
      const run = await runPromise
      const result = await run.result
      const output = (result.output ?? [])
        .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      const failed = result.stopReason !== undefined && result.stopReason !== 'completed'
      await input.hooks?.onSettled?.({ member: input.member, output, failed, ...result.stopReason ? { stopReason: result.stopReason } : {} })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      await input.hooks?.onSettled?.({ member: input.member, output: `execution failed: ${message}`, failed: true, stopReason: 'error' })
    } finally {
      this.#active.delete(memberId)
      input.hooks?.onStatusChange?.('idle')
    }
  }
}
