/**
 * ACP executor support for dsh-agent-teams.
 *
 * This module provides the ACP member transport, persistent session store,
 * ACP session provider, dynamic provider registry and provider config store.
 * A weave-style host can either use the default ACP wiring or register the
 * transport into `agentTeams/memberTransports` directly.
 *
 * @module dsh-agent-teams/acp
 */

export * from './acp-member-transport.js'
export { ExecutorSessionStore } from './executor-session-store.js'
export * from './acp-session-provider.js'
export * from './provider-extension.js'
export * from './provider-store.js'
export * from './dynamic-provider.js'
export * from './executor-provider.js'
export * from './executor-shared-types.js'
export { WeaveError } from './weave-error.js'

export * from './default-transport.js'
