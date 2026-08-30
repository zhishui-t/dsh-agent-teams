/**
 * Host hooks registry for external integration (weave knowledge/reflection).
 *
 * Hooks are best-effort: failures must not break fork's core team flow.
 * @module dsh-agent-teams/host-hooks
 */

export interface EnrichAssignmentInput {
  teamId: string
  memberName: string
  memberRole?: string
  memberExecutor?: string
  taskId: string
  prompt: string
}

export interface TaskSettledInput {
  teamId: string
  /** yaml/profile name that created this team, used for reflection projectId. */
  teamProfileName?: string
  taskId: string
  taskSubject?: string
  taskStatus: 'completed' | 'failed' | 'cancelled'
  memberName?: string
  memberRole?: string
  memberExecutor?: string
  output?: string
}

export interface AgentTeamsHostHooks {
  /** Return a possibly modified assignment prompt; return undefined to keep original. */
  enrichAssignment?(input: EnrichAssignmentInput): Promise<string | undefined> | string | undefined
  /** Task reached a terminal state. */
  onTaskSettled?(input: TaskSettledInput): Promise<void> | void
}

export class HostHooksRegistry {
  readonly #hooks = new Set<AgentTeamsHostHooks>()

  add(hooks: AgentTeamsHostHooks): () => void {
    this.#hooks.add(hooks)
    return () => { this.#hooks.delete(hooks) }
  }

  get size(): number {
    return this.#hooks.size
  }

  async enrichAssignment(input: EnrichAssignmentInput): Promise<string> {
    let prompt = input.prompt
    for (const hooks of this.#hooks) {
      try {
        const next = await hooks.enrichAssignment?.({ ...input, prompt })
        if (typeof next === 'string' && next.length > 0) prompt = next
      } catch (error: unknown) {
        // Best-effort: a host enrichment failure must not abort dispatch.
        console.warn(`[dsh-agent-teams] enrichAssignment hook failed: ${String(error)}`)
      }
    }
    return prompt
  }

  async onTaskSettled(input: TaskSettledInput): Promise<void> {
    for (const hooks of this.#hooks) {
      try {
        await hooks.onTaskSettled?.(input)
      } catch (error: unknown) {
        console.warn(`[dsh-agent-teams] onTaskSettled hook failed: ${String(error)}`)
      }
    }
  }
}
