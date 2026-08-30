/**
 * Member transport abstraction.
 *
 * The scheduler only knows about a member's available/idle/deliver/interrupt
 * surface. DSH continuable subagents (spawn/fork) are implemented by
 * DshMemberTransport; ACP and future executors can replace it without
 * changing scheduler semantics.
 * @module dsh-agent-teams/member-transport
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  deliverToMember,
  interruptMember,
  spawnMember,
  type MemberLlmSelection,
  type MemberRuntimeConfig,
  type MemberSelectionRuntime,
} from './members.js'
import type { TeamMember } from './types.js'

export type MemberRuntimeStatus = 'idle' | 'working'

export interface MemberSettledOutcome {
  member: TeamMember
  output: string
  failed: boolean
  stopReason?: string
}

export interface MemberDeliverHooks {
  onSettled?(outcome: MemberSettledOutcome): Promise<void>
  onStatusChange?(status: MemberRuntimeStatus): void
}

export interface MemberDeliverInput {
  captain: Agent
  member: TeamMember
  team: TeamStateLike
  workspace: string
  prompt: string
  signal?: AbortSignal
  hooks?: MemberDeliverHooks
}

export interface MemberProvisionInput {
  ctx: Context
  config: MemberRuntimeConfig
  selections: MemberSelectionRuntime
  llmSelection: MemberLlmSelection
  captain: Agent
  team: TeamStateLike
  member: TeamMember
  stateDir: string
  signal: AbortSignal
}

/** Structural slice to avoid importing TeamState in the public transport surface. */
export interface TeamStateLike {
  id: string
  name: string
  description?: string
  profile?: { protocol?: string; executionPrompt?: string }
}

export interface MemberTransport {
  readonly kind: string

  /** Create/restore the member execution identity and fill member.id. */
  provision(input: MemberProvisionInput): Promise<{ memberId: string }>

  /** Whether the member can be handed another unit of work. */
  isAvailable(member: TeamMember): boolean

  /** Deliver one turn of work (task assignment or mailbox fallback). */
  deliver(input: MemberDeliverInput): Promise<{ accepted: boolean }>

  /** Best-effort interrupt of the member's current execution. */
  interrupt(ctx: Context, captain: Agent, member: TeamMember): void

  /** Release member resources (default no-op). */
  dispose?(ctx: Context, member: TeamMember): Promise<void>
}

/** DSH continuable subagent transport used by spawn and fork providers. */
export class DshMemberTransport implements MemberTransport {
  readonly kind = 'dsh'

  constructor(private readonly ctx: Context) {}

  async provision(input: MemberProvisionInput): Promise<{ memberId: string }> {
    await spawnMember(
      input.ctx,
      input.config,
      input.selections,
      input.llmSelection,
      input.captain,
      input.team as Parameters<typeof spawnMember>[5],
      input.member,
      input.stateDir,
      input.signal,
    )
    return { memberId: input.member.id }
  }

  isAvailable(member: TeamMember): boolean {
    return isMemberAvailable(this.ctx, member)
  }

  async deliver(input: MemberDeliverInput): Promise<{ accepted: boolean }> {
    const accepted = await deliverToMember(
      this.ctx,
      input.captain,
      input.member.id,
      input.prompt,
      input.signal ?? new AbortController().signal,
    )
    if (accepted) {
      input.hooks?.onStatusChange?.('working')
      return { accepted: true }
    }
    return { accepted: false }
  }

  interrupt(ctx: Context, captain: Agent, member: TeamMember): void {
    interruptMember(ctx, captain, member.id)
  }

  async dispose(): Promise<void> {
    // DSH continuable members are retired through the existing guard.
  }
}

/** Resolve a member's configured executor to a transport kind. */
export function normalizeTransportKind(kind: string): string {
  if (kind === 'spawn' || kind === 'fork') return 'dsh'
  return kind.trim()
}

export class MemberTransportRegistry {
  readonly #transports = new Map<string, MemberTransport>()

  register(kind: string, transport: MemberTransport): () => void {
    const normalized = normalizeTransportKind(kind)
    if (this.#transports.has(normalized)) {
      throw new Error(`member transport already registered: ${normalized}`)
    }
    this.#transports.set(normalized, transport)
    return () => {
      if (this.#transports.get(normalized) === transport) this.#transports.delete(normalized)
    }
  }

  get(kind: string): MemberTransport | undefined {
    return this.#transports.get(normalizeTransportKind(kind))
  }

  has(kind: string): boolean {
    return this.#transports.has(normalizeTransportKind(kind))
  }

  resolve(member: TeamMember, fallbackKind: string): MemberTransport {
    const raw = member.executor?.trim() || fallbackKind
    const kind = normalizeTransportKind(raw)
    const transport = this.get(kind)
    if (transport === undefined) {
      throw new Error(
        `agent-teams: no member transport for "${raw}" (available: ${[...this.#transports.keys()].join(', ') || 'none'})`,
      )
    }
    return transport
  }
}

/** DSH-specific availability: a live resident member is unavailable while running. */
function isMemberAvailable(ctx: Context, member: TeamMember): boolean {
  if (member.id === '') return false
  const live = ctx.agents.get(member.id as SessionId)
  return live === undefined || live.status === 'idle'
}
