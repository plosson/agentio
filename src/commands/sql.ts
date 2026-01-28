import { Command } from 'commander';
import { setCredentials } from '../auth/token-store';
import { setProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { SqlClient } from '../services/sql/client';
import { CliError, handleError } from '../utils/errors';
import { readStdin, prompt } from '../utils/stdin';
import { interactiveSelect } from '../utils/interactive';
import { enforceWriteAccess } from '../utils/read-only';
import { isProfileReadOnly } from '../config/config-manager';
import type { SqlCredentials } from '../types/sql';

const getSqlClient = createClientGetter<SqlCredentials, SqlClient>({
  service: 'sql',
  createClient: (credentials) => new SqlClient(credentials),
});

function extractDisplayName(url: string): string {
  try {
    const parsed = new URL(url);
    const username = parsed.username ? decodeURIComponent(parsed.username) : '';
    const host = parsed.hostname || 'localhost';
    const db = parsed.pathname.replace(/^\//, '') || 'database';
    return username ? `${username}@${host}/${db}` : `${host}/${db}`;
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
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
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

        const { client: sqlClient, profile } = await getSqlClient(options.profile);
        client = sqlClient;

        // Check if the query is a write operation when profile is read-only
        const trimmedQuery = queryText.trim().toUpperCase();
        const isWriteQuery = !trimmedQuery.startsWith('SELECT') &&
                            !trimmedQuery.startsWith('SHOW') &&
                            !trimmedQuery.startsWith('DESCRIBE') &&
                            !trimmedQuery.startsWith('EXPLAIN');
        if (isWriteQuery) {
          await enforceWriteAccess('sql', profile, 'execute write query');
        }

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
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
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

        await setProfile('sql', profileName, { readOnly: options.readOnly });
        await setCredentials('sql', profileName, credentials);

        console.log(`\nProfile "${profileName}" configured!`);
        if (options.readOnly) {
          console.log(`   Access: read-only`);
        }
        console.log(`   Test with: agentio sql query --profile ${profileName} "SELECT 1"`);
      } catch (error) {
        handleError(error);
      }
    });
}

async function promptInteractiveConnection(): Promise<string> {
  console.error('\nSQL Database Setup (Interactive)\n');

  // Database type
  const dbType = await interactiveSelect({
    message: 'Select database type:',
    choices: [
      { name: 'PostgreSQL', value: 'postgres' as const, description: 'Default port 5432' },
      { name: 'MySQL', value: 'mysql' as const, description: 'Default port 3306' },
      { name: 'SQLite', value: 'sqlite' as const, description: 'Local file database' },
    ],
  });

  const defaultPort = dbType === 'postgres' ? '5432' : dbType === 'mysql' ? '3306' : '';

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
