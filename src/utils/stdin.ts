import { createInterface } from 'readline';
import { getProfile } from '../config/config-manager';
import type { ServiceName } from '../types/config';

/**
 * Prompt the user for input with a question.
 */
export function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for yes/no confirmation.
 */
export async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} (y/n): `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

/**
 * Resolve profile name, checking for existing profiles and prompting for override.
 * If the profile already exists, asks the user whether to override or choose a new name.
 */
export async function resolveProfileName(
  service: ServiceName,
  requestedName: string
): Promise<string> {
  const existingProfile = await getProfile(service, requestedName);

  if (!existingProfile) {
    // Profile doesn't exist, use the requested name
    return requestedName;
  }

  // Profile exists, ask if user wants to override
  console.error(`\nProfile "${requestedName}" already exists for ${service}.`);
  const shouldOverride = await confirm('Do you want to override it?');

  if (shouldOverride) {
    return requestedName;
  }

  // Ask for a new profile name
  const newName = await prompt('Enter a new profile name: ');

  if (!newName) {
    throw new Error('Profile name is required');
  }

  // Recursively check if the new name also exists
  return resolveProfileName(service, newName);
}

export async function readStdin(): Promise<string | null> {
  // Check if stdin is a TTY (interactive terminal)
  if (process.stdin.isTTY) {
    return null;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return null;
  }

  return Buffer.concat(chunks).toString('utf-8').trim();
}
