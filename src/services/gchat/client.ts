import { chat as gchat, type chat_v1 } from '@googleapis/chat';
import { OAuth2Client } from 'google-auth-library';
import { stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { basename, extname } from 'path';
import { CliError, httpStatusToErrorCode, type ErrorCode } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { GOOGLE_OAUTH_CONFIG } from '../../config/credentials';
import { GChatDirectory } from './directory';
import type {
  GChatCredentials,
  GChatSendOptions,
  GChatSendResult,
  GChatListOptions,
  GChatGetOptions,
  GChatWebhookCredentials,
  GChatOAuthCredentials,
  GChatMessage,
  GChatSpace,
  GChatUser,
  GChatMember,
} from '../../types/gchat';

interface ResolvedUser {
  displayName: string;
  email?: string;
}

const ATTACHMENT_EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export class GChatClient implements ServiceClient {
  private credentials: GChatCredentials;
  private userCache = new Map<string, ResolvedUser>();
  private fullUserCache = new Map<string, GChatUser>();
  private spaceIdCache = new Map<string, string>();
  private directory?: GChatDirectory;

  constructor(credentials: GChatCredentials) {
    this.credentials = credentials;
  }

  private ensureOAuth(operation: string): void {
    if (this.credentials.type === 'webhook') {
      throw new CliError(
        'PERMISSION_DENIED',
        `${operation} is not supported for webhook profiles`,
        'Use an OAuth profile'
      );
    }
  }

  private getOAuthChatApi(): { auth: OAuth2Client; chat: ReturnType<typeof gchat> } {
    const oauthCreds = this.credentials as GChatOAuthCredentials;
    const auth = this.createOAuthClient(oauthCreds);
    const chat = gchat({ version: 'v1', auth: auth as any });
    return { auth, chat };
  }

  async validate(): Promise<ValidationResult> {
    if (this.credentials.type === 'webhook') {
      // Cannot validate webhooks without sending a message
      return { valid: true, info: 'webhook' };
    }

    try {
      const { chat } = this.getOAuthChatApi();
      await chat.spaces.list({ pageSize: 1 });
      const oauthCreds = this.credentials as GChatOAuthCredentials;
      return { valid: true, info: oauthCreds.email || 'oauth' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
        return { valid: false, error: 'refresh token expired, re-authenticate' };
      }
      return { valid: false, error: message };
    }
  }

  async send(options: GChatSendOptions & { spaceId?: string }): Promise<GChatSendResult> {
    if (this.credentials.type === 'webhook') {
      if (options.attachments?.length) {
        throw new CliError(
          'PERMISSION_DENIED',
          'File attachments are not supported for webhook profiles',
          'Use an OAuth profile to send attachments'
        );
      }
      return this.sendViaWebhook(options);
    }
    if (options.spaceId) {
      options.spaceId = await this.resolveSpaceId(options.spaceId);
    }
    return this.sendViaOAuth(options);
  }

  async list(options: GChatListOptions): Promise<GChatMessage[]> {
    if (!options.spaceId?.trim()) {
      throw new CliError(
        'INVALID_PARAMS',
        'spaceId is required for listing messages',
        'Specify with --space or configure default in profile'
      );
    }
    this.ensureOAuth('Listing messages');
    options.spaceId = await this.resolveSpaceId(options.spaceId);
    return this.listViaOAuth(options);
  }

  async get(options: GChatGetOptions): Promise<GChatMessage> {
    if (!options.spaceId?.trim() || !options.messageId?.trim()) {
      throw new CliError(
        'INVALID_PARAMS',
        'Both spaceId and messageId are required',
        'Specify with --space and message ID'
      );
    }
    this.ensureOAuth('Getting messages');
    options.spaceId = await this.resolveSpaceId(options.spaceId);
    return this.getViaOAuth(options);
  }

  async listSpaces(): Promise<GChatSpace[]> {
    this.ensureOAuth('Listing spaces');
    return this.listSpacesViaOAuth();
  }

  async listMembers(spaceIdOrName: string): Promise<GChatMember[]> {
    this.ensureOAuth('Listing members');
    const spaceId = await this.resolveSpaceId(spaceIdOrName);
    return this.listMembersViaOAuth(spaceId);
  }

  async getUser(userIdOrResourceName: string): Promise<GChatUser> {
    this.ensureOAuth('Getting user info');
    const { auth } = this.getOAuthChatApi();
    const resourceName = userIdOrResourceName.startsWith('users/')
      ? userIdOrResourceName
      : `users/${userIdOrResourceName}`;
    const user = await this.fetchPerson(resourceName, auth);
    if (!user) {
      throw new CliError(
        'NOT_FOUND',
        `User not found: "${userIdOrResourceName}"`,
        'Check the user ID is valid'
      );
    }
    return user;
  }

  private async sendViaWebhook(options: GChatSendOptions): Promise<GChatSendResult> {
    const webhookUrl = (this.credentials as GChatWebhookCredentials).webhookUrl;

    if (!webhookUrl?.trim() || !webhookUrl.startsWith('https://')) {
      throw new CliError(
        'INVALID_PARAMS',
        'Invalid webhook URL - must be HTTPS',
        'Check the webhook URL configuration'
      );
    }

    // Use raw payload if provided, otherwise construct simple text message
    const payload = options.payload ?? { text: options.text };

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new CliError(
          'API_ERROR',
          `Failed to send message via webhook: ${response.status} ${error}`,
          'Check that the webhook URL is valid and the bot has permission to post'
        );
      }

      // Parse response to extract message ID
      let messageId = 'unknown';
      try {
        const responseData = (await response.json()) as Record<string, unknown>;
        const messageName = responseData.name as string | undefined;
        if (messageName) {
          messageId = messageName.split('/').pop() || 'unknown';
        }
      } catch {
        // If response is not JSON or parsing fails, keep messageId as 'unknown'
        // The message was still sent successfully (response.ok was true)
      }

      return {
        messageId: messageId,
        text: options.text,
        isJsonPayload: !!options.payload,
      };
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(
        'NETWORK_ERROR',
        `Webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
        'Verify the webhook URL is correct and accessible'
      );
    }
  }

  private async sendViaOAuth(options: GChatSendOptions & { spaceId?: string }): Promise<GChatSendResult> {
    const { chat } = this.getOAuthChatApi();

    if (!options.spaceId) {
      throw new CliError(
        'INVALID_PARAMS',
        'spaceId is required for OAuth profiles',
        'Specify with --space or configure default in profile'
      );
    }

    // Upload file attachments first (in parallel) to obtain attachmentDataRefs
    const attachmentRefs = options.attachments?.length
      ? await Promise.all(options.attachments.map(p => this.uploadAttachment(options.spaceId!, p, chat)))
      : [];

    // Use raw payload if provided, otherwise construct simple text message
    const requestBody: Record<string, unknown> = options.payload
      ? { ...options.payload }
      : { text: options.text };

    if (attachmentRefs.length) {
      const existing = Array.isArray(requestBody.attachment) ? requestBody.attachment as unknown[] : [];
      requestBody.attachment = [...existing, ...attachmentRefs.map(ref => ({ attachmentDataRef: ref }))];
    }

    try {
      const response = await chat.spaces.messages.create({
        parent: `spaces/${options.spaceId}`,
        requestBody: requestBody as chat_v1.Schema$Message,
      });

      const messageId = response.data.name?.split('/').pop() || 'unknown';

      return {
        messageId: messageId,
        spaceId: options.spaceId,
        text: options.text,
        isJsonPayload: !!options.payload,
      };
    } catch (err) {
      const code = this.getErrorCode(err);
      const message = this.getErrorMessage(err);
      throw new CliError(
        code,
        `Failed to send message: ${message}`,
        'Check that the space ID is valid and OAuth token is not expired'
      );
    }
  }

  private async uploadAttachment(
    spaceId: string,
    filePath: string,
    chat: ReturnType<typeof gchat>
  ): Promise<chat_v1.Schema$AttachmentDataRef> {
    try {
      await stat(filePath);
    } catch (err) {
      throw new CliError(
        'INVALID_PARAMS',
        `Failed to read attachment: ${filePath}`,
        'Check that the file exists and is readable'
      );
    }

    const filename = basename(filePath);
    const ext = extname(filePath).toLowerCase();
    const mimeType = ATTACHMENT_EXT_TO_MIME[ext] || 'application/octet-stream';

    try {
      const response = await chat.media.upload({
        parent: `spaces/${spaceId}`,
        requestBody: { filename },
        media: { mimeType, body: createReadStream(filePath) },
      });

      const ref = response.data.attachmentDataRef;
      if (!ref) {
        throw new CliError(
          'API_ERROR',
          `Upload of "${filename}" returned no attachmentDataRef`,
          'Retry, or check that the file size is under the Chat API limit (200MB)'
        );
      }
      return ref;
    } catch (err) {
      if (err instanceof CliError) throw err;
      const code = this.getErrorCode(err);
      const message = this.getErrorMessage(err);
      throw new CliError(
        code,
        `Failed to upload attachment "${filename}": ${message}`,
        'Check that the space ID is valid, OAuth scope includes chat.messages.create, and the file is under 200MB'
      );
    }
  }

  private async listViaOAuth(options: GChatListOptions): Promise<GChatMessage[]> {
    const { auth, chat } = this.getOAuthChatApi();

    try {
      // Build filter from options
      const filters: string[] = [];
      if (options.threadId) {
        filters.push(`thread.name = "spaces/${options.spaceId}/threads/${options.threadId}"`);
      }
      if (options.since) {
        filters.push(`createTime > "${options.since.toISOString()}"`);
      }
      const filter = filters.length > 0 ? filters.join(' AND ') : undefined;

      const response = await chat.spaces.messages.list({
        parent: `spaces/${options.spaceId}`,
        pageSize: options.limit || 10,
        orderBy: 'createTime desc',
        filter,
      });

      const messages = response.data.messages || [];

      // Resolve unique sender IDs to display names via People API
      const senderIds = [...new Set(messages.map(m => m.sender?.name).filter(Boolean))] as string[];
      await this.resolveUsers(senderIds, auth);

      return messages.map((msg: chat_v1.Schema$Message) => {
        const gchatMsg: GChatMessage = {
          name: msg.name || '',
          createTime: msg.createTime || new Date().toISOString(),
          // updateTime is not defined in chat_v1.Schema$Message, use lastUpdateTime as fallback
          updateTime: (msg as Record<string, unknown>).lastUpdateTime as string || new Date().toISOString(),
        };
        if (msg.text) gchatMsg.text = msg.text;
        gchatMsg.sender = this.enrichSender(msg);
        if (msg.thread?.name) {
          gchatMsg.thread = {
            name: msg.thread.name,
          };
        }
        return gchatMsg;
      });
    } catch (err) {
      const code = this.getErrorCode(err);
      const message = this.getErrorMessage(err);
      throw new CliError(
        code,
        `Failed to list messages: ${message}`,
        'Check that the space ID is valid and OAuth token is not expired'
      );
    }
  }

  private async getViaOAuth(options: GChatGetOptions): Promise<GChatMessage> {
    const { auth, chat } = this.getOAuthChatApi();

    try {
      const response = await chat.spaces.messages.get({
        name: `spaces/${options.spaceId}/messages/${options.messageId}`,
      });

      if (!response.data) {
        throw new Error('Message not found');
      }

      const msg = response.data as chat_v1.Schema$Message;

      // Resolve sender
      if (msg.sender?.name) {
        await this.resolveUsers([msg.sender.name], auth);
      }

      const gchatMsg: GChatMessage = {
        name: msg.name || '',
        createTime: msg.createTime || new Date().toISOString(),
        // updateTime is not defined in chat_v1.Schema$Message, use lastUpdateTime as fallback
        updateTime: (msg as Record<string, unknown>).lastUpdateTime as string || new Date().toISOString(),
      };
      if (msg.text) gchatMsg.text = msg.text;
      gchatMsg.sender = this.enrichSender(msg);
      if (msg.thread?.name) {
        gchatMsg.thread = {
          name: msg.thread.name,
        };
      }
      return gchatMsg;
    } catch (err) {
      const code = this.getErrorCode(err);
      const message = this.getErrorMessage(err);
      throw new CliError(
        code,
        `Failed to get message: ${message}`,
        'Check that the space ID and message ID are valid'
      );
    }
  }

  private async listSpacesViaOAuth(): Promise<GChatSpace[]> {
    const { chat } = this.getOAuthChatApi();

    try {
      const allSpaces: GChatSpace[] = [];
      let pageToken: string | undefined;

      do {
        const response = await chat.spaces.list({
          pageSize: 100,
          pageToken,
        });

        const spaces = response.data.spaces || [];
        for (const space of spaces) {
          allSpaces.push({
            name: space.name || '',
            displayName: space.displayName || 'Unnamed',
            type: (space.type as 'ROOM' | 'DM') || 'ROOM',
            description: space.spaceDetails?.description || undefined,
          });
        }

        pageToken = response.data.nextPageToken || undefined;
      } while (pageToken);

      return allSpaces;
    } catch (err) {
      const code = this.getErrorCode(err);
      const message = this.getErrorMessage(err);
      throw new CliError(
        code,
        `Failed to list spaces: ${message}`,
        'Check that OAuth token is valid and has Chat scope'
      );
    }
  }

  private async listMembersViaOAuth(spaceId: string): Promise<GChatMember[]> {
    const { auth, chat } = this.getOAuthChatApi();

    try {
      const allMembers: chat_v1.Schema$Membership[] = [];
      let pageToken: string | undefined;

      do {
        const response = await chat.spaces.members.list({
          parent: `spaces/${spaceId}`,
          pageSize: 100,
          pageToken,
        });
        const members = response.data.memberships || [];
        allMembers.push(...members);
        pageToken = response.data.nextPageToken || undefined;
      } while (pageToken);

      const userResourceNames = allMembers
        .map(m => m.member?.name)
        .filter((n): n is string => !!n && n.startsWith('users/'));
      const users = await Promise.all(
        userResourceNames.map(name => this.fetchPerson(name, auth))
      );
      const userByName = new Map<string, GChatUser>();
      for (const u of users) {
        if (u) userByName.set(u.name, u);
      }

      return allMembers.map((m): GChatMember => {
        const memberName = m.name || '';
        const userName = m.member?.name;
        const user = userName ? userByName.get(userName) : undefined;
        return {
          name: memberName,
          role: (m.role as GChatMember['role']) || 'ROLE_UNSPECIFIED',
          state: (m.state as GChatMember['state']) || 'MEMBERSHIP_STATE_UNSPECIFIED',
          memberType: (m.member?.type as GChatMember['memberType']) || 'HUMAN',
          user: user || (userName ? {
            name: userName,
            displayName: m.member?.displayName || undefined,
          } : undefined),
        };
      });
    } catch (err) {
      const code = this.getErrorCode(err);
      const message = this.getErrorMessage(err);
      throw new CliError(
        code,
        `Failed to list members: ${message}`,
        'Check that the space ID is valid and OAuth token is not expired'
      );
    }
  }

  /**
   * Fetch a single person from the People API with rich field set.
   * Returns undefined if the person cannot be fetched.
   */
  private async fetchPerson(userResourceName: string, auth: OAuth2Client): Promise<GChatUser | undefined> {
    const cached = this.fullUserCache.get(userResourceName);
    if (cached) return cached;

    const token = await auth.getAccessToken();
    if (!token.token) return undefined;

    const personId = userResourceName.replace('users/', '');
    const personFields = 'names,emailAddresses,phoneNumbers,organizations,photos,locations';
    try {
      const res = await fetch(
        `https://people.googleapis.com/v1/people/${personId}?personFields=${personFields}`,
        { headers: { Authorization: `Bearer ${token.token}` } }
      );
      if (!res.ok) return this.fallbackToDirectory(userResourceName, auth);
      const data = await res.json() as Record<string, any>;

      let displayName = data.names?.[0]?.displayName;
      let email = data.emailAddresses?.[0]?.value;
      const phoneNumbers = (data.phoneNumbers as Array<{ value?: string }> | undefined)
        ?.map(p => p.value).filter((v): v is string => !!v);
      const organizations = (data.organizations as Array<{ name?: string; title?: string; department?: string }> | undefined)
        ?.map(o => ({ name: o.name, title: o.title, department: o.department }));
      const photoUrl = (data.photos as Array<{ url?: string }> | undefined)?.[0]?.url;
      const locations = (data.locations as Array<{ value?: string }> | undefined)
        ?.map(l => l.value).filter((v): v is string => !!v);

      // Workspace coworkers come back as 200 OK with empty fields; fill in via directory cache.
      if (!displayName && !email) {
        const fallback = await this.fallbackToDirectory(userResourceName, auth);
        if (fallback) return fallback;
      }

      const user: GChatUser = {
        name: userResourceName,
        displayName,
        email,
        phoneNumbers: phoneNumbers?.length ? phoneNumbers : undefined,
        organizations: organizations?.length ? organizations : undefined,
        photoUrl,
        locations: locations?.length ? locations : undefined,
      };

      this.fullUserCache.set(userResourceName, user);
      // Warm the lightweight userCache so enrichSender benefits on future message lists
      if (displayName) {
        this.userCache.set(userResourceName, { displayName, email });
      }

      return user;
    } catch {
      return undefined;
    }
  }

  private async fallbackToDirectory(userResourceName: string, auth: OAuth2Client): Promise<GChatUser | undefined> {
    const directory = this.getDirectory();
    if (!directory) return undefined;
    try {
      await directory.ensureFresh(auth);
    } catch {
      return undefined;
    }
    const entry = directory.lookup(userResourceName);
    if (!entry) return undefined;
    const user: GChatUser = {
      name: userResourceName,
      displayName: entry.displayName,
      email: entry.email,
    };
    this.fullUserCache.set(userResourceName, user);
    this.userCache.set(userResourceName, { displayName: entry.displayName, email: entry.email });
    return user;
  }

  /**
   * Resolve a space identifier that may be an ID or a display name.
   * Tries as ID first (no API call), falls back to name resolution via listSpaces.
   * Results are cached for the lifetime of this client instance.
   */
  private async resolveSpaceId(spaceIdOrName: string): Promise<string> {
    const cached = this.spaceIdCache.get(spaceIdOrName);
    if (cached) return cached;

    const { chat } = this.getOAuthChatApi();

    // Try as ID first
    try {
      const resp = await chat.spaces.get({ name: `spaces/${spaceIdOrName}` });
      if (resp.data.name) {
        this.spaceIdCache.set(spaceIdOrName, spaceIdOrName);
        return spaceIdOrName;
      }
    } catch {
      // Not a valid ID, try as display name
    }

    // Resolve by display name
    const spaces = await this.listSpacesViaOAuth();
    const nameLower = spaceIdOrName.toLowerCase();
    const match = spaces.find(s => s.displayName.toLowerCase() === nameLower);

    if (!match) {
      throw new CliError(
        'NOT_FOUND',
        `Space not found: "${spaceIdOrName}"`,
        'Use "agentio gchat spaces" to list available spaces'
      );
    }

    const id = match.name.replace('spaces/', '');
    this.spaceIdCache.set(spaceIdOrName, id);
    return id;
  }

  private async resolveUsers(userIds: string[], auth: OAuth2Client): Promise<void> {
    const unknown = userIds.filter(id => !this.userCache.has(id));
    if (unknown.length === 0) return;

    // Try the workspace directory cache first (refreshes once per day).
    const directory = this.getDirectory();
    if (directory) {
      try {
        await directory.ensureFresh(auth);
      } catch {
        // Directory unavailable; fall through to per-user People API
      }
      for (const userId of unknown) {
        const entry = directory.lookup(userId);
        if (entry) {
          this.userCache.set(userId, { displayName: entry.displayName, email: entry.email });
        }
      }
    }

    const stillUnknown = unknown.filter(id => !this.userCache.has(id));
    if (stillUnknown.length === 0) return;

    const token = await auth.getAccessToken();
    if (!token.token) return;

    // Fall back to per-user People API for self / personal contacts.
    await Promise.all(stillUnknown.map(async (userId) => {
      try {
        const personId = userId.replace('users/', '');
        const res = await fetch(
          `https://people.googleapis.com/v1/people/${personId}?personFields=names,emailAddresses`,
          { headers: { Authorization: `Bearer ${token.token}` } }
        );
        if (!res.ok) return;
        const data = await res.json() as Record<string, any>;
        const name = data.names?.[0]?.displayName;
        const email = data.emailAddresses?.[0]?.value;
        if (name) {
          this.userCache.set(userId, { displayName: name, email });
        }
      } catch {
        // Silently skip unresolvable users
      }
    }));
  }

  getDirectory(): GChatDirectory | undefined {
    if (this.credentials.type !== 'oauth') return undefined;
    if (!this.directory) {
      const oauth = this.credentials as GChatOAuthCredentials;
      if (!oauth.email) return undefined;
      this.directory = new GChatDirectory(oauth.email);
    }
    return this.directory;
  }

  async refreshDirectory(): Promise<{ size: number; path: string; fetchedAt: string }> {
    this.ensureOAuth('Refreshing directory');
    const directory = this.getDirectory();
    if (!directory) {
      throw new CliError('CONFIG_ERROR', 'Directory cache requires an OAuth profile with an email');
    }
    const { auth } = this.getOAuthChatApi();
    await directory.ensureFresh(auth, { force: true });
    return {
      size: directory.size(),
      path: directory.filePath(),
      fetchedAt: directory.fetchedAt() || new Date().toISOString(),
    };
  }

  private enrichSender(msg: chat_v1.Schema$Message): GChatMessage['sender'] {
    if (!msg.sender?.name) return undefined;
    const cached = this.userCache.get(msg.sender.name);
    return {
      name: msg.sender.name,
      displayName: cached?.displayName || msg.sender.displayName || msg.sender.name,
      email: cached?.email,
    };
  }

  private getErrorCode(err: unknown): ErrorCode {
    if (err && typeof err === 'object') {
      const error = err as Record<string, unknown>;
      const code = error.code || error.status;
      if (typeof code === 'number') {
        return httpStatusToErrorCode(code);
      }
    }
    return 'API_ERROR';
  }

  private getErrorMessage(err: unknown): string {
    if (err && typeof err === 'object') {
      const error = err as Record<string, unknown>;
      const code = error.code || error.status;
      if (code === 401) return 'OAuth token expired or invalid';
      if (code === 403) return 'Bot lacks permission for this operation';
      if (code === 404) return 'Space or message not found';
      if (code === 429) return 'Rate limit exceeded, please try again later';
      if (error.message && typeof error.message === 'string') {
        return error.message;
      }
    }
    return err instanceof Error ? err.message : String(err);
  }

  private createOAuthClient(credentials: GChatOAuthCredentials) {
    const oauth2Client = new OAuth2Client(
      GOOGLE_OAUTH_CONFIG.clientId,
      GOOGLE_OAUTH_CONFIG.clientSecret
    );

    oauth2Client.setCredentials({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      expiry_date: credentials.expiryDate,
    });

    return oauth2Client;
  }
}
