import { writeJson } from '../../utils/output';
import type { PagerioSentPage } from './types';

export function printSentPage(page: PagerioSentPage, json?: boolean): void {
  if (json) {
    writeJson(page, 2);
    return;
  }
  console.log('Page sent');
  console.log(`  ID: ${page.id}`);
  console.log(`  View: ${page.view_url}`);
}
