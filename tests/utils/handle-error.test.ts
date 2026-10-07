import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { CliError, handleError } from '../../src/utils/errors';

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
let exit: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Exit(code); }) as never);
  error = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { exit.mockRestore(); error.mockRestore(); });

const codeOf = (fn: () => void) => { try { fn(); } catch (e) { return (e as Exit).code; } throw new Error('no exit'); };

test('the general exit code replaces 1 only', () => {
  expect(codeOf(() => handleError(new CliError('INVALID_PARAMS', 'x'), 6))).toBe(6);
  expect(codeOf(() => handleError(new Error('boom'), 6))).toBe(6);
  expect(codeOf(() => handleError('weird', 6))).toBe(6);
  expect(codeOf(() => handleError(new CliError('AUTH_FAILED', 'x'), 6))).toBe(2);
  expect(codeOf(() => handleError(new CliError('PROFILE_NOT_FOUND', 'x'), 6))).toBe(3);
  expect(codeOf(() => handleError(new CliError('NETWORK_ERROR', 'x'), 6))).toBe(4);
  expect(codeOf(() => handleError(new CliError('RATE_LIMITED', 'x'), 6))).toBe(5);
});

test('without it, nothing changes', () => {
  expect(codeOf(() => handleError(new CliError('INVALID_PARAMS', 'x')))).toBe(1);
  expect(codeOf(() => handleError(new Error('boom')))).toBe(1);
});
