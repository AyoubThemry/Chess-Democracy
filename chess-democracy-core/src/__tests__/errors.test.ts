import { describe, it, expect } from 'vitest';
import { toError, errorMessage } from '../utils/errors.js';

describe('toError', () => {
    it('returns the same Error instance when given an Error', () => {
        const err = new Error('original');
        expect(toError(err)).toBe(err);
    });

    it('wraps a string in an Error', () => {
        const result = toError('boom');
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe('boom');
    });

    it('wraps a number in an Error', () => {
        const result = toError(42);
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe('42');
    });

    it('wraps null in an Error', () => {
        const result = toError(null);
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe('null');
    });

    it('wraps undefined in an Error', () => {
        const result = toError(undefined);
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe('undefined');
    });

    it('wraps a plain object in an Error', () => {
        const result = toError({ code: 'ENOENT' });
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toBe('[object Object]'); // String({}) is [object Object]
    });
});

describe('errorMessage', () => {
    it('extracts message from an Error', () => {
        expect(errorMessage(new Error('hello'))).toBe('hello');
    });

    it('converts a string directly', () => {
        expect(errorMessage('raw string')).toBe('raw string');
    });

    it('converts a number to string', () => {
        expect(errorMessage(7)).toBe('7');
    });
});
