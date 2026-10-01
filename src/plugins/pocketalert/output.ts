import { writeJson } from '../../utils/output';
import type { PocketAlertMessage } from './types';

export function printSentMessage(message: PocketAlertMessage, json?: boolean): void {
  if (json) {
    writeJson(message, 2);
    return;
  }
  console.log('Message sent');
  console.log(`  ID: ${message.tid}`);
  console.log(`  Title: ${message.title}`);
  if (message.application) console.log(`  Application: ${message.application}`);
  if (message.device) console.log(`  Device: ${message.device}`);
  if (message.created_at) console.log(`  Created: ${message.created_at}`);
}
