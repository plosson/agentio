import { writeJson } from '../../utils/output';

/** Names, sorted; with `reveal`, each name with its value. */
export function printSecrets(values: Map<string, string>, options: { reveal: boolean; json?: boolean }): void {
  const keys = [...values.keys()].sort();
  if (options.json) {
    writeJson(options.reveal ? { values: Object.fromEntries(keys.map((key) => [key, values.get(key)!])) } : { keys }, 2);
    return;
  }
  if (keys.length === 0) {
    console.error('No secrets in this profile');
    return;
  }
  for (const key of keys) console.log(options.reveal ? `${key}=${values.get(key)}` : key);
}
