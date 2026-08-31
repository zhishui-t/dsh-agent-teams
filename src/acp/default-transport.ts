/**
 * Default ACP member transport wiring for dsh-agent-teams.
 *
 * When the host has a `subprocess` service and a local ZCode ACP server is
 * discoverable from the environment, this helper creates the default zcode
 * ACP provider and registers an `acp` member transport into the team runtime.
 * It is intentionally best-effort: missing ZCode or subprocess is not an error.
 *
 * @module dsh-agent-teams/acp/default-transport
 */

import {
  AcpSessionProvider,
  zcodeAcpProviderConfigFromEnvironment,
  ZcodeAcpExecutorProvider,
} from './acp-session-provider.js'
import { AcpMemberTransport } from './acp-member-transport.js'
import { ExecutorSessionStore } from './executor-session-store.js'
import type { MemberTransportRegistry } from '../member-transport.js'

/** Structural subprocess slice to avoid a hard cordis service type dependency. */
export interface AcpDefaultSubprocessLike {
  spawn(spec: {
    argv: string[]
    cwd?: string
    env?: Record<string, string>
    stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'inherit' | 'ignore' | 'pipe' }
    graceMs?: number
  }): unknown
}

export interface AcpDefaultRegistrationContext {
  get?(name: string): unknown
  subprocess?: AcpDefaultSubprocessLike
}

/**
 * Best-effort register the default `acp` member transport.
 *
 * @returns true when the transport was registered; false when ZCode/subprocess
 * is unavailable or an acp transport is already present.
 */
export function registerDefaultAcpMemberTransport(
  ctx: AcpDefaultRegistrationContext,
  registry: MemberTransportRegistry,
): boolean {
  if (registry.has('acp')) return false
  const subprocess = (ctx.get?.('subprocess') ?? ctx.subprocess) as AcpDefaultSubprocessLike | undefined
  if (!subprocess) return false
  const config = zcodeAcpProviderConfigFromEnvironment(process.env)
  if (!config) return false

  try {
    const acp = new AcpSessionProvider(config, (spec) => subprocess.spawn(spec) as never)
    const transport = new AcpMemberTransport(
      new ZcodeAcpExecutorProvider(acp) as never,
      new ExecutorSessionStore(),
    )
    registry.register('acp', transport)
    return true
  } catch (error) {
    console.warn(`[dsh-agent-teams] default ACP transport registration failed: ${String(error)}`)
    return false
  }
}
