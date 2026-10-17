/** Error constructors shared by the engine and the fixture. */

import { EngineError } from 'e2e/engine';

export function cancelled(text: string): EngineError {
  return new EngineError('CANCELLED', text, { retryable: false });
}

export function invalidState(text: string): EngineError {
  return new EngineError('INVALID_STATE', text, { retryable: false });
}

export function notActionable(text: string): EngineError {
  return new EngineError('NOT_ACTIONABLE', text, { retryable: false });
}

export function unsupported(text: string): EngineError {
  return new EngineError('UNSUPPORTED_CAPABILITY', text, { retryable: false });
}

export function failure(text: string, cause?: unknown): EngineError {
  return new EngineError('ENGINE_FAILURE', text, { retryable: false, ...(cause === undefined ? {} : { cause }) });
}

export function message(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** Constrains a caller-supplied artifact label to a safe filename. */
export function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'artifact';
}
