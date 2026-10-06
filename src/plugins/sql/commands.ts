import { Command } from 'commander';
import { createProfileCommands } from '../../utils/profile-commands';
import { addProfileWithSetup, addSetupOptions } from '../profile-host';
import { createClientGetter } from '../../utils/client-factory';
import { SqlClient } from './client';
import { CliError, handleError } from '../../utils/errors';
import { readStdin } from '../../utils/stdin';
import { isProfileReadOnly } from '../../config/config-manager';
import { addExamples } from '../../utils/command-tree';
import type { SqlCredentials } from './types';
import type { InputSpec, SetupContext, SetupResult } from '../../plugin-sdk';
import { SQL_URL_INPUT } from './setup-needs';

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
    // Not the URL itself, which may hold a password.
    return 'database';
  }
}

export function registerSqlCommands(program: Command): void {
  const sql = program
    .command('sql')
    .description('SQL database operations');

  addExamples(
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

        const readOnly = await isProfileReadOnly('sql', profile);
        const result = await client.query({ query: queryText, limit }, { readOnly });
        console.log(client.formatResult(result));
      } catch (error) {
        handleError(error);
      } finally {
        client?.close();
      }
    }),
    `Examples:

  # one-shot SELECT against the default profile
  agentio sql query "SELECT id, email FROM users LIMIT 10"

  # cap rows for an exploratory query
  agentio sql query "SELECT * FROM events" --limit 25

  # pipe a multi-line query via stdin
  cat report.sql | agentio sql query

  # run against a specific profile
  agentio sql query --profile prod "SELECT count(*) FROM orders"`,
  );

  // Profile management
  const profile = createProfileCommands<SqlCredentials>(sql, {
    service: 'sql',
    displayName: 'SQL',
    getExtraInfo: (credentials) => credentials?.displayName ? ` - ${credentials.displayName}` : '',
  });

  addSetupOptions(
    profile
      .command('add')
      .description('Add a new SQL database profile')
      .option('--profile <name>', 'Profile name (auto-detected from connection if not provided)')
      .option('--interactive', 'Interactive mode: prompt for individual connection components')
      .option('--read-only', 'Create as read-only profile (blocks write operations)')
  )
    .action(async (options) => {
      try {
        await addProfileWithSetup('sql', sqlProfileAdd, options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function sqlProfileAdd(options: { profile?: string; interactive?: boolean; readOnly?: boolean }, context: SetupContext): Promise<SetupResult<SqlCredentials>> {
  let url: string;

  if (options.interactive) {
    url = await promptInteractiveConnection(context);
  } else {
    context.log('\nSQL Database Setup\n');
    context.log('Enter your database connection URL.');
    context.log('Supported formats:');
    context.log('  PostgreSQL: postgres://user:password@host:5432/database');
    context.log('  MySQL:      mysql://user:password@host:3306/database');
    context.log('  SQLite:     sqlite:///path/to/database.db\n');
    context.log('Tip: Use --interactive to enter components separately (handles special characters)\n');

    url = await context.ask(SQL_URL_INPUT);
  }

  // Validate connection
  context.log('\nValidating connection...');
  const displayName = extractDisplayName(url);
  try {
    const tempClient = new SqlClient({ url });
    try {
      await tempClient.query({ query: 'SELECT 1' });
    } finally {
      tempClient.close();
    }
  } catch {
    // The driver's own message can quote the connection URL, which holds the password.
    throw new CliError('AUTH_FAILED', `Failed to connect to ${displayName}`);
  }

  context.log(`\nConnected to: ${displayName}\n`);

  const credentials: SqlCredentials = {
    url,
    displayName,
  };

  // A profile name cannot hold "/", which every display name has (`user@host/db`).
  return { credentials, suggestedProfileName: displayName.replaceAll('/', '-'), info: 'Test with: agentio sql query "SELECT 1"' };
}

// Asked at run time, not declared in the needs: the parts depend on the database type.
const DB_TYPE_INPUT: InputSpec = {
  id: 'dbType', label: 'Database type', kind: 'choice',
  choices: [
    { value: 'postgres', label: 'PostgreSQL' },
    { value: 'mysql', label: 'MySQL' },
    { value: 'sqlite', label: 'SQLite' },
  ],
};
const PATH_INPUT: InputSpec = { id: 'path', label: 'Database file path', kind: 'text' };
const HOST_INPUT: InputSpec = { id: 'host', label: 'Host', kind: 'text', default: 'localhost' };
const DATABASE_INPUT: InputSpec = { id: 'database', label: 'Database name', kind: 'text' };
const USER_INPUT: InputSpec = { id: 'user', label: 'Username', kind: 'text' };
const PASSWORD_INPUT: InputSpec = { id: 'password', label: 'Password', kind: 'secret', required: false };

async function promptInteractiveConnection(context: SetupContext): Promise<string> {
  context.log('\nSQL Database Setup (Interactive)\n');

  const dbType = await context.ask(DB_TYPE_INPUT);

  // SQLite only needs a file path
  if (dbType === 'sqlite') {
    return `sqlite://${await context.ask(PATH_INPUT)}`;
  }

  // For postgres/mysql, collect connection components
  const defaultPort = dbType === 'postgres' ? '5432' : '3306';
  const host = await context.ask(HOST_INPUT);
  const port = await context.ask({ id: 'port', label: 'Port', kind: 'text', default: defaultPort, required: false }) || defaultPort;
  const database = await context.ask(DATABASE_INPUT);
  const username = await context.ask(USER_INPUT);
  const password = await context.ask(PASSWORD_INPUT);

  // Build URL with proper encoding
  const encodedUsername = encodeURIComponent(username);
  const encodedDatabase = encodeURIComponent(database);
  const credentials = password
    ? `${encodedUsername}:${encodeURIComponent(password)}`
    : encodedUsername;

  return `${dbType}://${credentials}@${host}:${port}/${encodedDatabase}`;
}
