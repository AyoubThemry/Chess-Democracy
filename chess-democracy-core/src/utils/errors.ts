// ---------------------------------------------------------------------------
// Shared error utilities for the Chess-Hive backend.
//
// Rule: never write `error as Error` or `catch(e: any)` anywhere else.
// Import `toError` here and use it instead.
// ---------------------------------------------------------------------------

/**
 * Safely coerces an unknown catch-clause value to an Error object.
 * If it already is an Error, it is returned as-is.
 * If it is a string or anything else, it is wrapped in a new Error.
 */
export function toError(value: unknown): Error {
    if (value instanceof Error) return value;
    return new Error(String(value));
}

/**
 * Extracts a human-readable message from any thrown value.
 * Safe to use directly in log statements.
 */
export function errorMessage(value: unknown): string {
    return toError(value).message;
}
