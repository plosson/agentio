import {
  select,
  checkbox,
  confirm as inquirerConfirm,
  input,
} from '@inquirer/prompts';
import { CliError } from './errors';

export interface SelectChoice<T> {
  name: string;
  value: T;
  description?: string;
}

export interface CheckboxChoice<T> {
  name: string;
  value: T;
  checked?: boolean;
}

/**
 * Check if running in an interactive terminal.
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Interactive select prompt. Falls back to default or throws if not in TTY.
 */
export async function interactiveSelect<T>(options: {
  message: string;
  choices: SelectChoice<T>[];
  default?: T;
}): Promise<T> {
  if (!isInteractive()) {
    if (options.default !== undefined) {
      return options.default;
    }
    throw new CliError(
      'INVALID_PARAMS',
      'Interactive input required but not running in terminal',
      'Run this command in an interactive terminal'
    );
  }

  return select({
    message: options.message,
    choices: options.choices,
    default: options.default,
    loop: false,
  });
}

/**
 * Interactive checkbox (multi-select) prompt. Falls back to default or throws if not in TTY.
 */
export async function interactiveCheckbox<T>(options: {
  message: string;
  choices: CheckboxChoice<T>[];
  required?: boolean;
}): Promise<T[]> {
  if (!isInteractive()) {
    // Return all checked items as default
    const defaults = options.choices.filter((c) => c.checked).map((c) => c.value);
    if (defaults.length > 0 || !options.required) {
      return defaults;
    }
    throw new CliError(
      'INVALID_PARAMS',
      'Interactive input required but not running in terminal',
      'Run this command in an interactive terminal'
    );
  }

  const result = await checkbox({
    message: options.message,
    choices: options.choices,
    loop: false,
  });

  if (options.required && result.length === 0) {
    throw new CliError('INVALID_PARAMS', 'At least one option must be selected');
  }

  return result;
}

/**
 * Interactive confirm prompt. Falls back to default or throws if not in TTY.
 */
export async function interactiveConfirm(options: {
  message: string;
  default?: boolean;
}): Promise<boolean> {
  if (!isInteractive()) {
    if (options.default !== undefined) {
      return options.default;
    }
    throw new CliError(
      'INVALID_PARAMS',
      'Interactive input required but not running in terminal',
      'Run this command in an interactive terminal'
    );
  }

  return inquirerConfirm({
    message: options.message,
    default: options.default,
  });
}

/**
 * Interactive text input prompt. Falls back to default or throws if not in TTY.
 */
export async function interactiveInput(options: {
  message: string;
  default?: string;
  required?: boolean;
}): Promise<string> {
  if (!isInteractive()) {
    if (options.default !== undefined) {
      return options.default;
    }
    if (!options.required) {
      return '';
    }
    throw new CliError(
      'INVALID_PARAMS',
      'Interactive input required but not running in terminal',
      'Run this command in an interactive terminal'
    );
  }

  const result = await input({
    message: options.message,
    default: options.default,
  });

  if (options.required && !result.trim()) {
    throw new CliError('INVALID_PARAMS', 'Input is required');
  }

  return result;
}
