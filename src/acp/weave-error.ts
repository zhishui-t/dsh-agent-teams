/** TDD 1.1.2 错误码语义的通用业务错误。 */
export class WeaveError extends Error {
  readonly code: string
  readonly details: Record<string, unknown> | undefined

  constructor(code: string, message?: string, details?: Record<string, unknown>) {
    super(message ?? code)
    this.name = 'WeaveError'
    this.code = code
    this.details = details
  }
}
