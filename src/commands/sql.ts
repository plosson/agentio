import { Command } from 'commander';
import { setCredentials } from '../auth/token-store';
import { setProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { SqlClient } from '../services/sql/client';
import { CliError, handleError } from '../utils/errors';
import { readStdin, prompt } from '../utils/stdin';
import type { SqlCredentials } from '../types/sql';

const getSqlClient = createClientGetter<SqlCredentials, SqlClient>({
  service: 'sql',
  createClient: (credentials) => new SqlClient(credentials),
});

function extractDisplayName(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || 'localhost';
    const db = parsed.pathname.replace(/^\//, '') || 'database';
    return `${host}/${db}`;
  } catch {
    return url.substring(0, 30);
  }
}

export function registerSqlCommands(program: Command): void {
  const sql = program
    .command('sql')
    .description('SQL database operations');

  sql
    .command('query')
    .description('Execute a SQL query')
    .requiredOption('--profile <name>', 'Profile name')
    .option('--limit <n>', 'Maximum rows to return', '100')
    .argument('[query]', 'SQL query (or pipe via stdin)')
    .action(async (query: string | undefined, options) => {
      let client: SqlClient | undefined;
      try {
        const queryText = query || await readStdin();

        if (!queryText) {
          throw new CliError('INVALID_PARAMS', 'Query is required. Provide as argument or pipe via stdin.');
        }

        const limit = parseInt(options.limit, 10);
        if (isNaN(limit) || limit <= 0) {
          throw new CliError('INVALID_PARAMS', 'Limit must be a positive number');
        }

        const { client: sqlClient } = await getSqlClient(options.profile);
        client = sqlClient;

        const result = await client.query({ query: queryText, limit });
        console.log(client.formatResult(result));
      } catch (error) {
        handleError(error);
      } finally {
        client?.close();
      }
    });

  // Profile management
  const profile = createProfileCommands<SqlCredentials>(sql, {
    service: 'sql',
    displayName: 'SQL',
    getExtraInfo: (credentials) => credentials?.displayName ? ` - ${credentials.displayName}` : '',
  });

  profile
    .command('add')
    .description('Add a new SQL database profile')
    .option('--profile <name>', 'Profile name (auto-detected from connection if not provided)')
    .option('--interactive', 'Interactive mode: prompt for individual connection components')
    .action(async (options) => {
      try {
        let url: string;

        if (options.interactive) {
          url = await promptInteractiveConnection();
        } else {
          console.error('\nSQL Database Setup\n');
          console.error('Enter your database connection URL.');
          console.error('Supported formats:');
          console.error('  PostgreSQL: postgres://user:password@host:5432/database');
          console.error('  MySQL:      mysql://user:password@host:3306/database');
          console.error('  SQLite:     sqlite:///path/to/database.db\n');
          console.error('Tip: Use --interactive to enter components separately (handles special characters)\n');

          const urlInput = await prompt('? Connection URL: ');

          if (!urlInput) {
            throw new CliError('INVALID_PARAMS', 'Connection URL is required');
          }
          url = urlInput;
        }

        // Validate connection
        console.error('\nValidating connection...');
        const tempClient = new SqlClient({ url });
        try {
          await tempClient.query({ query: 'SELECT 1' });
        } catch (error) {
          tempClient.close();
          if (error instanceof CliError) {
            throw error;
          }
          throw new CliError('AUTH_FAILED', `Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        tempClient.close();

        const displayName = extractDisplayName(url);
        console.error(`\nConnected to: ${displayName}\n`);

        // Auto-name based on connection display name
        const profileName = options.profile || displayName;

        // Save credentials
        const credentials: SqlCredentials = {
          url,
          displayName,
        };

        await setProfile('sql', profileName);
        await setCredentials('sql', profileName, credentials);

        console.log(`\nProfile "${profileName}" configured!`);
        console.log(`   Test with: agentio sql query --profile ${profileName} "SELECT 1"`);
      } catch (error) {
        handleError(error);
      }
    });
}

async function promptInteractiveConnection(): Promise<string> {
  console.error('\nSQL Database Setup (Interactive)\n');

  // Database type
  console.error('Database type:');
  console.error('  1. PostgreSQL');
  console.error('  2. MySQL');
  console.error('  3. SQLite\n');

  const typeChoice = await prompt('? Select type (1-3): ');
  let dbType: 'postgres' | 'mysql' | 'sqlite';
  let defaultPort: string;

  switch (typeChoice) {
    case '1':
      dbType = 'postgres';
      defaultPort = '5432';
      break;
    case '2':
      dbType = 'mysql';
      defaultPort = '3306';
      break;
    case '3':
      dbType = 'sqlite';
      defaultPort = '';
      break;
    default:
      throw new CliError('INVALID_PARAMS', 'Invalid database type selection');
  }

  // SQLite only needs a file path
  if (dbType === 'sqlite') {
    const dbPath = await prompt('? Database file path: ');
    if (!dbPath) {
      throw new CliError('INVALID_PARAMS', 'Database path is required');
    }
    return `sqlite://${dbPath}`;
  }

  // For postgres/mysql, collect connection components
  const host = await prompt('? Host (e.g., localhost): ');
  if (!host) {
    throw new CliError('INVALID_PARAMS', 'Host is required');
  }

  const portInput = await prompt(`? Port [${defaultPort}]: `);
  const port = portInput || defaultPort;

  const database = await prompt('? Database name: ');
  if (!database) {
    throw new CliError('INVALID_PARAMS', 'Database name is required');
  }

  const username = await prompt('? Username: ');
  if (!username) {
    throw new CliError('INVALID_PARAMS', 'Username is required');
  }

  const password = await prompt('? Password: ');

  // Build URL with proper encoding
  const encodedUsername = encodeURIComponent(username);
  const encodedDatabase = encodeURIComponent(database);
  const credentials = password
    ? `${encodedUsername}:${encodeURIComponent(password)}`
    : encodedUsername;

  return `${dbType}://${credentials}@${host}:${port}/${encodedDatabase}`;
}
