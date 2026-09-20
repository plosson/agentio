// Google Sheets specific formatters
import type {
  GSheetsListItem,
  GSheetsSpreadsheet,
  GSheetsGetResult,
  GSheetsUpdateResult,
  GSheetsAppendResult,
  GSheetsClearResult,
  GSheetsCreateResult,
  GSheetsFormatResult,
  GSheetsResizeResult,
  GSheetsBatchResult,
} from './types';

export function printGSheetsList(spreadsheets: GSheetsListItem[]): void {
  if (spreadsheets.length === 0) {
    console.log('No spreadsheets found');
    return;
  }

  console.log(`Spreadsheets (${spreadsheets.length})\n`);

  for (let i = 0; i < spreadsheets.length; i++) {
    const sheet = spreadsheets[i];
    console.log(`[${i + 1}] ${sheet.title}`);
    console.log(`    ID: ${sheet.id}`);
    if (sheet.owner) console.log(`    Owner: ${sheet.owner}`);
    if (sheet.modifiedTime) console.log(`    Modified: ${sheet.modifiedTime}`);
    console.log(`    Link: ${sheet.webViewLink}`);
    console.log('');
  }
}

export function printGSheetsMetadata(spreadsheet: GSheetsSpreadsheet): void {
  console.log(`ID: ${spreadsheet.id}`);
  console.log(`Title: ${spreadsheet.title}`);
  if (spreadsheet.locale) console.log(`Locale: ${spreadsheet.locale}`);
  if (spreadsheet.timeZone) console.log(`TimeZone: ${spreadsheet.timeZone}`);
  console.log(`URL: ${spreadsheet.url}`);
  console.log('');
  console.log('Sheets:');

  for (const sheet of spreadsheet.sheets) {
    console.log(`  [${sheet.id}] ${sheet.title} (${sheet.rowCount} rows x ${sheet.columnCount} cols)`);
  }
}

export function printGSheetsValues(result: GSheetsGetResult): void {
  if (result.values.length === 0) {
    console.log('No data found');
    return;
  }

  console.log(`Range: ${result.range}\n`);

  for (const row of result.values) {
    const cells = row.map((cell) => String(cell ?? ''));
    console.log(cells.join('\t'));
  }
}

export function printGSheetsUpdateResult(result: GSheetsUpdateResult): void {
  console.log(`Updated ${result.updatedCells} cells in ${result.updatedRange}`);
  console.log(`  Rows: ${result.updatedRows}`);
  console.log(`  Columns: ${result.updatedColumns}`);
}

export function printGSheetsAppendResult(result: GSheetsAppendResult): void {
  console.log(`Appended ${result.updatedCells} cells to ${result.updatedRange}`);
  console.log(`  Rows: ${result.updatedRows}`);
  console.log(`  Columns: ${result.updatedColumns}`);
}

export function printGSheetsClearResult(result: GSheetsClearResult): void {
  console.log(`Cleared ${result.clearedRange}`);
}

export function printGSheetsCreated(result: GSheetsCreateResult): void {
  console.log('Spreadsheet created');
  console.log(`ID: ${result.id}`);
  console.log(`Title: ${result.title}`);
  console.log(`URL: ${result.url}`);
}

export function printGSheetsFormatResult(result: GSheetsFormatResult): void {
  console.log(`Formatted ${result.range}`);
  console.log(`  Sheet: ${result.sheetTitle}`);
  if (result.cleared) console.log('  Cleared existing formatting');
  if (result.appliedFields.length > 0) {
    console.log(`  Applied: ${result.appliedFields.join(', ')}`);
  }
  if (result.merged) console.log('  Merged: yes');
}

export function printGSheetsResizeResult(result: GSheetsResizeResult): void {
  const unit = result.dimension === 'COLUMNS' ? 'column(s)' : 'row(s)';
  const how = result.auto ? 'auto-fit' : `${result.pixelSize}px`;
  console.log(`Resized ${result.count} ${unit} in ${result.range}`);
  console.log(`  Sheet: ${result.sheetTitle}`);
  console.log(`  Size: ${how}`);
}

export function printGSheetsBatchResult(result: GSheetsBatchResult): void {
  console.log(`Batch update applied to ${result.spreadsheetId}`);
  console.log(`  Replies: ${result.replies}`);
}
