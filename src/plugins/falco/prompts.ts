import { password as inquirerPassword, input, select } from '@inquirer/prompts';

/**
 * Thin wrappers over @inquirer/prompts so the login flow reads the same way
 * whether it runs from `profile add` or from reauthentication.
 */

export function promptText(message: string, defaultValue?: string): Promise<string> {
  return input({ message, default: defaultValue }).then((value) => value.trim());
}

export function promptPassword(message: string): Promise<string> {
  return inquirerPassword({ message, mask: true });
}

export function promptChoice<T>(message: string, choices: Array<{ name: string; value: T }>): Promise<T> {
  // One option needs no question; returning it directly keeps a single-org
  // login non-interactive past the password.
  if (choices.length === 1) return Promise.resolve(choices[0]!.value);
  return select({ message, choices });
}
