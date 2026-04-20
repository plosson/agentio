import { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { createGoogleAuth, fetchGoogleUserEmail } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile, getProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { performOAuthFlow } from '../auth/oauth';
import { GSheetsClient } from '../services/gsheets/client';
import {
  printGSheetsList,
  printGSheetsMetadata,
  printGSheetsValues,
  printGSheetsUpdateResult,
  printGSheetsAppendResult,
  printGSheetsClearResult,
  printGSheetsCreated,
  printGSheetsFormatResult,
  printGSheetsResizeResult,
  printGSheetsBatchResult,
} from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { enforceWriteAccess } from '../utils/read-only';
import type {
  GSheetsCredentials,
  GSheetsFormatOptions,
  GSheetsHorizontalAlignment,
  GSheetsVerticalAlignment,
  GSheetsWrapStrategy,
  GSheetsBorderStyle,
} from '../types/gsheets';

const getGSheetsClient = createClientGetter<GSheetsCredentials, GSheetsClient>({
  service: 'gsheets',
  createClient: (credentials) => new GSheetsClient(credentials),
});

/**
 * Parse values from CLI arguments or JSON
 * Supports two formats:
 * - Simple: comma-separated rows, pipe-separated cells (e.g., "a|b|c,d|e|f")
 * - JSON: 2D array (e.g., '[["a","b"],["c","d"]]')
 */
function parseValues(valueArgs: string[], valuesJson?: string): unknown[][] {
  if (valuesJson) {
    try {
      const parsed = JSON.parse(valuesJson);
      if (!Array.isArray(parsed)) {
        throw new Error('JSON must be a 2D array');
      }
      return parsed;
    } catch (err) {
      throw new CliError('INVALID_PARAMS', `Invalid JSON values: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (valueArgs.length === 0) {
    throw new CliError('INVALID_PARAMS', 'No values provided', 'Provide values as args or via --values-json');
  }

  // Parse simple format: comma-separated rows, pipe-separated cells
  const rawValues = valueArgs.join(' ');
  const rows = rawValues.split(',');
  return rows.map((row) => {
    const cells = row.trim().split('|');
    return cells.map((cell) => cell.trim());
  });
}

function parseAlign(value?: string): GSheetsHorizontalAlignment | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === 'left') return 'LEFT';
  if (v === 'center' || v === 'centre') return 'CENTER';
  if (v === 'right') return 'RIGHT';
  throw new CliError('INVALID_PARAMS', `Invalid --align value: ${value}`, 'Use left, center, or right');
}

function parseValign(value?: string): GSheetsVerticalAlignment | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === 'top') return 'TOP';
  if (v === 'middle' || v === 'center') return 'MIDDLE';
  if (v === 'bottom') return 'BOTTOM';
  throw new CliError('INVALID_PARAMS', `Invalid --valign value: ${value}`, 'Use top, middle, or bottom');
}

function parseWrap(value?: string): GSheetsWrapStrategy | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === 'overflow') return 'OVERFLOW_CELL';
  if (v === 'clip') return 'CLIP';
  if (v === 'wrap') return 'WRAP';
  throw new CliError('INVALID_PARAMS', `Invalid --wrap value: ${value}`, 'Use overflow, clip, or wrap');
}

function parseBorder(value?: string): GSheetsBorderStyle | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === 'all' || v === 'outer' || v === 'none') return v;
  throw new CliError('INVALID_PARAMS', `Invalid --border value: ${value}`, 'Use all, outer, or none');
}

function parseRawFormat(json?: string): Record<string, unknown> | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new CliError('INVALID_PARAMS', `Invalid --raw JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('INVALID_PARAMS', '--raw must be a JSON object (CellFormat)');
  }
  return parsed as Record<string, unknown>;
}

export function registerGSheetsCommands(program: Command): void {
  const gsheets = program.command('gsheets').description('Google Sheets operations');

  gsheets
    .command('list')
    .description('List recent spreadsheets')
    .option('--profile <name>', 'Profile name')
    .option('--limit <n>', 'Number of spreadsheets', '10')
    .option('--query <query>', 'Drive search query filter')
    .addHelpText(
      'after',
      `
Query Syntax Examples:

  Name search:
    --query "name contains 'budget'"      Spreadsheets with "budget" in name
    --query "name = 'Q1 Report'"          Exact name match

  Ownership:
    --query "'me' in owners"              Spreadsheets you own
    --query "'user@example.com' in owners"

  Date filters:
    --query "modifiedTime > '2024-01-01'" Modified after date
    --query "createdTime > '2024-01-01'"  Created after date

  Combined:
    --query "name contains 'sales' and modifiedTime > '2024-01-01'"
`
    )
    .action(async (options) => {
      try {
        const { client } = await getGSheetsClient(options.profile);
        const spreadsheets = await client.list({
          limit: parseInt(options.limit, 10),
          query: options.query,
        });
        printGSheetsList(spreadsheets);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('get')
    .argument('<spreadsheet-id-or-url>', 'Spreadsheet ID or URL')
    .argument('<range>', 'Range in A1 notation (e.g., Sheet1!A1:B10)')
    .description('Get values from a range')
    .option('--profile <name>', 'Profile name')
    .option('--dimension <dim>', 'Major dimension: ROWS or COLUMNS')
    .option('--render <opt>', 'Value render: FORMATTED_VALUE, UNFORMATTED_VALUE, or FORMULA')
    .action(async (spreadsheetId: string, range: string, options) => {
      try {
        const { client } = await getGSheetsClient(options.profile);
        const result = await client.get(spreadsheetId, range, {
          majorDimension: options.dimension,
          valueRenderOption: options.render,
        });
        printGSheetsValues(result);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('update')
    .argument('<spreadsheet-id-or-url>', 'Spreadsheet ID or URL')
    .argument('<range>', 'Range in A1 notation (e.g., Sheet1!A1:B2)')
    .argument('[values...]', 'Values (comma-separated rows, pipe-separated cells)')
    .description('Update values in a range')
    .option('--profile <name>', 'Profile name')
    .option('--values-json <json>', 'Values as JSON 2D array')
    .option('--input <opt>', 'Value input option: RAW or USER_ENTERED', 'USER_ENTERED')
    .addHelpText(
      'after',
      `
Value Formats:

  Simple format (comma = row separator, pipe = cell separator):
    agentio gsheets update <id> Sheet1!A1:B2 "a|b,c|d"
    Results in:
      A1=a  B1=b
      A2=c  B2=d

  JSON format:
    agentio gsheets update <id> Sheet1!A1:B2 --values-json '[["a","b"],["c","d"]]'

Input Options:
  RAW          - Values are stored exactly as entered (no parsing)
  USER_ENTERED - Values are parsed as if typed in the UI (formulas, dates, etc.)
`
    )
    .action(async (spreadsheetId: string, range: string, valueArgs: string[], options) => {
      try {
        const values = parseValues(valueArgs, options.valuesJson);
        const { client, profile } = await getGSheetsClient(options.profile);
        await enforceWriteAccess('gsheets', profile, 'update values');
        const result = await client.update(spreadsheetId, range, values, {
          valueInputOption: options.input,
        });
        printGSheetsUpdateResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('append')
    .argument('<spreadsheet-id-or-url>', 'Spreadsheet ID or URL')
    .argument('<range>', 'Range in A1 notation (e.g., Sheet1!A:C)')
    .argument('[values...]', 'Values (comma-separated rows, pipe-separated cells)')
    .description('Append values to a range')
    .option('--profile <name>', 'Profile name')
    .option('--values-json <json>', 'Values as JSON 2D array')
    .option('--input <opt>', 'Value input option: RAW or USER_ENTERED', 'USER_ENTERED')
    .option('--insert <opt>', 'Insert data option: OVERWRITE or INSERT_ROWS')
    .addHelpText(
      'after',
      `
Value Formats:

  Simple format (comma = row separator, pipe = cell separator):
    agentio gsheets append <id> Sheet1!A:C "a|b|c,d|e|f"
    Appends two rows to columns A, B, C

  JSON format:
    agentio gsheets append <id> Sheet1!A:C --values-json '[["a","b","c"],["d","e","f"]]'

Insert Options:
  OVERWRITE   - New data overwrites existing data in the areas it is written
  INSERT_ROWS - Rows are inserted for the new data
`
    )
    .action(async (spreadsheetId: string, range: string, valueArgs: string[], options) => {
      try {
        const values = parseValues(valueArgs, options.valuesJson);
        const { client, profile } = await getGSheetsClient(options.profile);
        await enforceWriteAccess('gsheets', profile, 'append values');
        const result = await client.append(spreadsheetId, range, values, {
          valueInputOption: options.input,
          insertDataOption: options.insert,
        });
        printGSheetsAppendResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('clear')
    .argument('<spreadsheet-id-or-url>', 'Spreadsheet ID or URL')
    .argument('<range>', 'Range in A1 notation (e.g., Sheet1!A1:B10)')
    .description('Clear values in a range')
    .option('--profile <name>', 'Profile name')
    .action(async (spreadsheetId: string, range: string, options) => {
      try {
        const { client, profile } = await getGSheetsClient(options.profile);
        await enforceWriteAccess('gsheets', profile, 'clear values');
        const result = await client.clear(spreadsheetId, range);
        printGSheetsClearResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('format')
    .argument('<spreadsheet-id-or-url>', 'Spreadsheet ID or URL')
    .argument('<range>', 'Range in A1 notation (e.g., Sheet1!A1:B10)')
    .description('Apply cell formatting (colors, text style, alignment, borders, merge)')
    .option('--profile <name>', 'Profile name')
    .option('--bold', 'Make text bold')
    .option('--italic', 'Make text italic')
    .option('--underline', 'Underline text')
    .option('--font-size <n>', 'Font size in points', (v) => parseInt(v, 10))
    .option('--font-family <name>', 'Font family name (e.g., "Arial")')
    .option('--text-color <hex>', 'Text color as #rrggbb')
    .option('--background <hex>', 'Background color as #rrggbb')
    .option('--align <pos>', 'Horizontal alignment: left, center, right')
    .option('--valign <pos>', 'Vertical alignment: top, middle, bottom')
    .option('--wrap <strategy>', 'Text wrap: overflow, clip, wrap')
    .option('--number-format <pattern>', 'Number format pattern (e.g., "$#,##0.00", "0.00%")')
    .option('--border <style>', 'Borders: all, outer, none')
    .option('--merge', 'Merge the range into a single cell')
    .option('--clear-format', 'Clear existing formatting on the range first')
    .option('--raw <json>', 'Raw CellFormat JSON merged into the request')
    .addHelpText(
      'after',
      `
Examples:
  # Bold header row with colored background
  agentio gsheets format <id> Sheet1!A1:D1 --bold --background "#4285f4" --text-color "#ffffff"

  # Currency column
  agentio gsheets format <id> Sheet1!C2:C100 --number-format "$#,##0.00"

  # Outer border around a table
  agentio gsheets format <id> Sheet1!A1:D10 --border outer

  # Reset formatting on a range
  agentio gsheets format <id> Sheet1!A1:Z1000 --clear-format

  # Merge title cells
  agentio gsheets format <id> Sheet1!A1:D1 --merge --align center --bold
`
    )
    .action(async (spreadsheetId: string, range: string, options) => {
      try {
        const { client, profile } = await getGSheetsClient(options.profile);
        await enforceWriteAccess('gsheets', profile, 'format range');

        const formatOptions: GSheetsFormatOptions = {
          bold: options.bold,
          italic: options.italic,
          underline: options.underline,
          fontSize: options.fontSize,
          fontFamily: options.fontFamily,
          textColor: options.textColor,
          backgroundColor: options.background,
          horizontalAlignment: parseAlign(options.align),
          verticalAlignment: parseValign(options.valign),
          wrapStrategy: parseWrap(options.wrap),
          numberFormat: options.numberFormat,
          border: parseBorder(options.border),
          merge: options.merge,
          clearFormat: options.clearFormat,
          raw: parseRawFormat(options.raw),
        };

        const result = await client.format(spreadsheetId, range, formatOptions);
        printGSheetsFormatResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('resize')
    .argument('<spreadsheet-id-or-url>', 'Spreadsheet ID or URL')
    .argument('<range>', 'Columns (Sheet1!A:C) or rows (Sheet1!1:10)')
    .description('Resize columns or rows (explicit pixel size or auto-fit)')
    .option('--profile <name>', 'Profile name')
    .option('--size <pixels>', 'Pixel size', (v) => parseInt(v, 10))
    .option('--auto', 'Auto-fit to content')
    .addHelpText(
      'after',
      `
Examples:
  # Set columns A-C to 200px wide
  agentio gsheets resize <id> Sheet1!A:C --size 200

  # Auto-fit the first row to content
  agentio gsheets resize <id> Sheet1!1:1 --auto

  # Resize a single column
  agentio gsheets resize <id> Sheet1!B --size 150

Notes:
  - Range must be columns-only (A:C) or rows-only (1:10), not both.
  - --size and --auto are mutually exclusive.
`
    )
    .action(async (spreadsheetId: string, range: string, options) => {
      try {
        const { client, profile } = await getGSheetsClient(options.profile);
        await enforceWriteAccess('gsheets', profile, 'resize range');
        const result = await client.resize(spreadsheetId, range, {
          pixelSize: options.size,
          auto: options.auto,
        });
        printGSheetsResizeResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('batch')
    .argument('<spreadsheet-id-or-url>', 'Spreadsheet ID or URL')
    .description('Execute raw spreadsheets.batchUpdate requests (escape hatch)')
    .option('--profile <name>', 'Profile name')
    .option('--requests-json <json>', 'Inline JSON array of batchUpdate requests')
    .option('--file <path>', 'Path to a JSON file containing the requests array')
    .addHelpText(
      'after',
      `
Accepts an array of Google Sheets batchUpdate Request objects. Reference:
  https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request

Examples:
  # Freeze the first row
  agentio gsheets batch <id> --requests-json '[
    {"updateSheetProperties":{"properties":{"sheetId":0,"gridProperties":{"frozenRowCount":1}},"fields":"gridProperties.frozenRowCount"}}
  ]'

  # From a file
  agentio gsheets batch <id> --file ./requests.json
`
    )
    .action(async (spreadsheetId: string, options) => {
      try {
        if (!options.requestsJson && !options.file) {
          throw new CliError('INVALID_PARAMS', 'Provide --requests-json or --file');
        }
        if (options.requestsJson && options.file) {
          throw new CliError('INVALID_PARAMS', '--requests-json and --file are mutually exclusive');
        }

        const source = options.requestsJson ?? (await readFile(options.file, 'utf8'));
        let parsed: unknown;
        try {
          parsed = JSON.parse(source);
        } catch (err) {
          throw new CliError('INVALID_PARAMS', `Invalid JSON: ${err instanceof Error ? err.message : err}`);
        }
        if (!Array.isArray(parsed)) {
          throw new CliError('INVALID_PARAMS', 'Input must be a JSON array of Request objects');
        }

        const { client, profile } = await getGSheetsClient(options.profile);
        await enforceWriteAccess('gsheets', profile, 'execute batch update');
        const result = await client.batch(spreadsheetId, parsed as Parameters<typeof client.batch>[1]);
        printGSheetsBatchResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('metadata')
    .argument('<spreadsheet-id-or-url>', 'Spreadsheet ID or URL')
    .description('Get spreadsheet metadata')
    .option('--profile <name>', 'Profile name')
    .action(async (spreadsheetId: string, options) => {
      try {
        const { client } = await getGSheetsClient(options.profile);
        const metadata = await client.metadata(spreadsheetId);
        printGSheetsMetadata(metadata);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('create')
    .argument('<title>', 'Spreadsheet title')
    .description('Create a new spreadsheet')
    .option('--profile <name>', 'Profile name')
    .option('--sheets <names>', 'Comma-separated sheet names to create')
    .action(async (title: string, options) => {
      try {
        const { client, profile } = await getGSheetsClient(options.profile);
        await enforceWriteAccess('gsheets', profile, 'create spreadsheet');
        const sheetNames = options.sheets ? options.sheets.split(',').map((n: string) => n.trim()) : undefined;
        const result = await client.create(title, sheetNames);
        printGSheetsCreated(result);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('copy')
    .argument('<spreadsheet-id-or-url>', 'Spreadsheet ID or URL')
    .argument('<title>', 'New spreadsheet title')
    .description('Copy a spreadsheet')
    .option('--profile <name>', 'Profile name')
    .option('--parent <folder-id>', 'Destination folder ID')
    .action(async (spreadsheetId: string, title: string, options) => {
      try {
        const { client, profile } = await getGSheetsClient(options.profile);
        await enforceWriteAccess('gsheets', profile, 'copy spreadsheet');
        const result = await client.copy(spreadsheetId, title, options.parent);
        printGSheetsCreated(result);
      } catch (error) {
        handleError(error);
      }
    });

  gsheets
    .command('export')
    .argument('<spreadsheet-id-or-url>', 'Spreadsheet ID or URL')
    .description('Export a spreadsheet to a file')
    .option('--profile <name>', 'Profile name')
    .requiredOption('--output <path>', 'Output file path')
    .option('--format <fmt>', 'Export format: xlsx, pdf, csv, ods, tsv', 'xlsx')
    .addHelpText(
      'after',
      `
Export Formats:
  xlsx - Microsoft Excel (default)
  pdf  - PDF document
  csv  - Comma-separated values (first sheet only)
  ods  - OpenDocument Spreadsheet
  tsv  - Tab-separated values (first sheet only)

Examples:
  agentio gsheets export <id> --output report.xlsx
  agentio gsheets export <id> --output data.csv --format csv
`
    )
    .action(async (spreadsheetId: string, options) => {
      try {
        const { client } = await getGSheetsClient(options.profile);
        const format = options.format.toLowerCase();

        if (!['xlsx', 'pdf', 'csv', 'ods', 'tsv'].includes(format)) {
          throw new CliError('INVALID_PARAMS', `Unknown format: ${format}`, 'Use xlsx, pdf, csv, ods, or tsv');
        }

        const result = await client.export(spreadsheetId, format as 'xlsx' | 'pdf' | 'csv' | 'ods' | 'tsv');
        await writeFile(options.output, result.data);
        console.log(`Exported to ${options.output}`);
        console.log(`  Format: ${format}`);
        console.log(`  Size: ${result.data.length} bytes`);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = createProfileCommands<GSheetsCredentials>(gsheets, {
    service: 'gsheets',
    displayName: 'Google Sheets',
    getExtraInfo: (credentials) => (credentials?.email ? ` - ${credentials.email}` : ''),
  });

  profile
    .command('add')
    .description('Add a new Google Sheets profile')
    .option('--profile <name>', 'Profile name (auto-detected from email if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        console.error('Starting OAuth flow for Google Sheets...\n');

        const tokens = await performOAuthFlow('gsheets');

        // Fetch user email for profile naming
        let userEmail: string;
        try {
          userEmail = await fetchGoogleUserEmail(tokens.access_token);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new CliError('AUTH_FAILED', `Failed to fetch user email: ${errorMessage}`, 'Ensure the account has an email address');
        }

        // Determine profile name: use explicit --profile, or email, or email-readonly if conflict
        let profileName: string;
        if (options.profile) {
          profileName = options.profile;
        } else if (options.readOnly && await getProfile('gsheets', userEmail)) {
          // Profile with email already exists, use -readonly suffix
          profileName = `${userEmail}-readonly`;
        } else {
          profileName = userEmail;
        }

        const credentials: GSheetsCredentials = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date,
          tokenType: tokens.token_type,
          scope: tokens.scope,
          email: userEmail,
        };

        await setProfile('gsheets', profileName, { readOnly: options.readOnly });
        await setCredentials('gsheets', profileName, credentials);

        console.log(`\nSuccess! Profile "${profileName}" configured.`);
        console.log(`   Email: ${userEmail}`);
        if (options.readOnly) {
          console.log(`   Access: read-only`);
        }
        console.log(`   Test with: agentio gsheets list --profile ${profileName}`);
      } catch (error) {
        handleError(error);
      }
    });
}
