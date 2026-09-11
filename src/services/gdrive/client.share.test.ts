import { describe, expect, test } from 'bun:test';
import { GDriveClient } from './client';
import type { GDriveCredentials } from '../../types/gdrive';

const CREDENTIALS: GDriveCredentials = {
  accessToken: 'token',
  refreshToken: 'refresh',
  expiryDate: Date.now() + 60_000,
  tokenType: 'Bearer',
  scope: 'https://www.googleapis.com/auth/drive',
  email: 'owner@example.com',
  accessLevel: 'full',
};

describe('gdrive share request body', () => {
  test('omits allowFileDiscovery for user shares', async () => {
    const client = new GDriveClient(CREDENTIALS);
    let body: Record<string, unknown> | undefined;

    (client as any).drive.permissions.create = async (opts: { requestBody: Record<string, unknown> }) => {
      body = opts.requestBody;
      return { data: { id: 'perm-1', type: 'user', role: 'writer', emailAddress: 'a@b.com' } };
    };

    await client.share('file-1', {
      type: 'user',
      role: 'writer',
      emailAddress: 'a@b.com',
      allowFileDiscovery: false,
    });

    expect(body).toEqual({
      type: 'user',
      role: 'writer',
      emailAddress: 'a@b.com',
    });
    expect(body).not.toHaveProperty('allowFileDiscovery');
  });

  test('includes allowFileDiscovery for anyone shares', async () => {
    const client = new GDriveClient(CREDENTIALS);
    let body: Record<string, unknown> | undefined;

    (client as any).drive.permissions.create = async (opts: { requestBody: Record<string, unknown> }) => {
      body = opts.requestBody;
      return { data: { id: 'perm-2', type: 'anyone', role: 'reader' } };
    };

    await client.share('file-1', {
      type: 'anyone',
      role: 'reader',
      allowFileDiscovery: true,
    });

    expect(body).toEqual({
      type: 'anyone',
      role: 'reader',
      allowFileDiscovery: true,
    });
  });
});
