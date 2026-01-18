import sodium from 'libsodium-wrappers';
import type { GitHubCredentials, GitHubUser, GitHubPublicKey } from '../../types/github';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';

const GITHUB_API_BASE = 'https://api.github.com';

export class GitHubClient implements ServiceClient {
  private accessToken: string;

  constructor(credentials: GitHubCredentials) {
    this.accessToken = credentials.accessToken;
  }

  async validate(): Promise<ValidationResult> {
    try {
      const user = await this.getUser();
      return { valid: true, info: user.login };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${GITHUB_API_BASE}${path}`;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle no-content responses (204)
      if (response.status === 204) {
        return {} as T;
      }

      const data = await response.json();

      if (!response.ok) {
        const errorMessage = data.message || 'Unknown GitHub API error';

        if (response.status === 401) {
          throw new CliError('AUTH_FAILED', `GitHub authentication failed: ${errorMessage}`);
        }
        if (response.status === 403) {
          throw new CliError('PERMISSION_DENIED', `Permission denied: ${errorMessage}`, 'You need admin access to set secrets on this repository');
        }
        if (response.status === 404) {
          throw new CliError('NOT_FOUND', `Not found: ${errorMessage}`, 'Check that the repository exists and you have access to it');
        }
        if (response.status === 429) {
          throw new CliError('RATE_LIMITED', `Rate limited: ${errorMessage}`);
        }

        throw new CliError('API_ERROR', `GitHub API error: ${errorMessage}`);
      }

      return data as T;
    } catch (error) {
      if (error instanceof CliError) throw error;

      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new CliError('NETWORK_ERROR', `Failed to connect to GitHub: ${message}`);
    }
  }

  async getUser(): Promise<GitHubUser> {
    return this.request<GitHubUser>('GET', '/user');
  }

  async getRepoPublicKey(repo: string): Promise<GitHubPublicKey> {
    return this.request<GitHubPublicKey>('GET', `/repos/${repo}/actions/secrets/public-key`);
  }

  async setRepoSecret(repo: string, secretName: string, secretValue: string): Promise<void> {
    // Ensure libsodium is ready
    await sodium.ready;

    // Get the repo's public key
    const publicKey = await this.getRepoPublicKey(repo);

    // Encrypt the secret using libsodium sealed box
    const keyBytes = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL);
    const messageBytes = sodium.from_string(secretValue);
    const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
    const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

    // Upload the encrypted secret
    await this.request('PUT', `/repos/${repo}/actions/secrets/${secretName}`, {
      encrypted_value: encryptedValue,
      key_id: publicKey.key_id,
    });
  }

  async deleteRepoSecret(repo: string, secretName: string): Promise<void> {
    await this.request('DELETE', `/repos/${repo}/actions/secrets/${secretName}`);
  }
}
