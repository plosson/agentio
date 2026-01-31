import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import { createGoogleAuth, fetchGoogleUserEmail } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile } from '../config/config-manager';
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
} from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { enforceWriteAccess } from '../utils/read-only';
import type { GSheetsCredentials } from '../types/gsheets';

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

        const profileName = options.profile || userEmail;

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
