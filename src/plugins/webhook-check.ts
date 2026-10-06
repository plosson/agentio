import type { SetupContext } from '../plugin-sdk';
import { CliError } from '../utils/errors';

// Shared by the services added with an incoming webhook URL (Slack, Google Chat). Not a plugin.

export interface WebhookCheck {
  /** The start every real URL of this service has, scheme and host included. */
  prefix: string;
  /** The INVALID_PARAMS message and suggestion for a URL without that prefix. */
  invalidMessage: string;
  invalidSuggestion: string;
  /** Quote the answer's body when the test POST is refused. */
  showResponseBody?: boolean;
}

/**
 * Checks a webhook URL before it is saved: its prefix, then one test POST.
 * A network failure never quotes the error text, which can hold the URL, and the URL is the secret.
 */
export async function checkWebhookUrl(url: string, check: WebhookCheck, context: SetupContext): Promise<void> {
  if (!url.startsWith(check.prefix)) {
    throw new CliError('INVALID_PARAMS', check.invalidMessage, check.invalidSuggestion);
  }

  let response: Response;
  try {
    response = await context.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'Test message from agentio' }),
    });
  } catch {
    throw new CliError('API_ERROR', 'Failed to validate webhook', 'Check that the URL is correct and accessible');
  }

  if (!response.ok) {
    const body = check.showResponseBody ? ` ${await response.text().catch(() => '')}` : '';
    throw new CliError('API_ERROR', `Webhook validation failed: ${response.status}${body}`, 'Check the webhook URL and try again');
  }
}
