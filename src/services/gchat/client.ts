import { chat as gchat, type chat_v1 } from '@googleapis/chat';
import { OAuth2Client } from 'google-auth-library';
import { CliError, httpStatusToErrorCode, type ErrorCode } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { GOOGLE_OAUTH_CONFIG } from '../../config/credentials';
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

export class GChatClient implements ServiceClient {
  private credentials: GChatCredentials;
  private userCache = new Map<string, ResolvedUser>();
  private fullUserCache = new Map<string, GChatUser>();
  private spaceIdCache = new Map<string, string>();

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

    // Use raw payload if provided, otherwise construct simple text message
    const requestBody = options.payload ?? { text: options.text };

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
      if (!res.ok) return undefined;
      const data = await res.json() as Record<string, any>;

      const displayName = data.names?.[0]?.displayName;
      const email = data.emailAddresses?.[0]?.value;
      const phoneNumbers = (data.phoneNumbers as Array<{ value?: string }> | undefined)
        ?.map(p => p.value).filter((v): v is string => !!v);
      const organizations = (data.organizations as Array<{ name?: string; title?: string; department?: string }> | undefined)
        ?.map(o => ({ name: o.name, title: o.title, department: o.department }));
      const photoUrl = (data.photos as Array<{ url?: string }> | undefined)?.[0]?.url;
      const locations = (data.locations as Array<{ value?: string }> | undefined)
        ?.map(l => l.value).filter((v): v is string => !!v);

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

    const token = await auth.getAccessToken();
    if (!token.token) return;

    // Resolve users in parallel via People API
    await Promise.all(unknown.map(async (userId) => {
      try {
        // userId is like "users/123456", extract the numeric part
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
