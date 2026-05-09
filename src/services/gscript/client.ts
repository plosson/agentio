import { script, type script_v1 } from '@googleapis/script';
import { drive, type drive_v3 } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
import { CliError, httpStatusToErrorCode, type ErrorCode } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { GOOGLE_OAUTH_CONFIG } from '../../config/credentials';
import type {
  GScriptCredentials,
  GScriptFile,
  GScriptProject,
  GScriptListItem,
  GScriptListOptions,
  GScriptCreateOptions,
} from '../../types/gscript';

const SCRIPT_MIME = 'application/vnd.google-apps.script';

export class GScriptClient implements ServiceClient {
  private credentials: GScriptCredentials;
  private script: script_v1.Script;
  private drive: drive_v3.Drive;

  constructor(credentials: GScriptCredentials) {
    this.credentials = credentials;
    const auth = this.createOAuthClient();
    this.script = script({ version: 'v1', auth: auth as any });
    this.drive = drive({ version: 'v3', auth: auth as any });
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.drive.files.list({
        pageSize: 1,
        q: `mimeType='${SCRIPT_MIME}'`,
      });
      return { valid: true, info: this.credentials.email };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
        return { valid: false, error: 'refresh token expired, re-authenticate' };
      }
      return { valid: false, error: message };
    }
  }

  async create(options: GScriptCreateOptions): Promise<GScriptProject> {
    try {
      const response = await this.script.projects.create({
        requestBody: { title: options.title, parentId: options.parentId },
      });
      return this.toProject(response.data);
    } catch (err) {
      this.throwApiError(err, 'create script project');
    }
  }

  async metadata(scriptId: string): Promise<GScriptProject> {
    try {
      const response = await this.script.projects.get({ scriptId });
      return this.toProject(response.data);
    } catch (err) {
      this.throwApiError(err, 'get script project metadata');
    }
  }

  async list(options: GScriptListOptions = {}): Promise<GScriptListItem[]> {
    const { parentId, limit = 25 } = options;

    let q = `mimeType='${SCRIPT_MIME}' and trashed=false`;
    if (parentId) q += ` and '${parentId}' in parents`;

    try {
      const response = await this.drive.files.list({
        pageSize: Math.min(limit, 100),
        q,
        fields: 'files(id,name,parents,modifiedTime)',
        orderBy: 'modifiedTime desc',
      });

      return (response.data.files || []).map((file) => ({
        scriptId: file.id!,
        title: file.name || 'Untitled',
        parentId: file.parents?.[0],
        modifiedTime: file.modifiedTime || undefined,
      }));
    } catch (err) {
      this.throwApiError(err, 'list script projects');
    }
  }

  async delete(scriptId: string): Promise<void> {
    try {
      await this.drive.files.delete({ fileId: scriptId });
    } catch (err) {
      this.throwApiError(err, 'delete script project');
    }
  }

  async getContent(scriptId: string): Promise<GScriptFile[]> {
    try {
      const response = await this.script.projects.getContent({ scriptId });
      return (response.data.files || []).map((f) => ({
        name: f.name || '',
        type: (f.type || 'SERVER_JS') as GScriptFile['type'],
        source: f.source || '',
      }));
    } catch (err) {
      this.throwApiError(err, 'get script content');
    }
  }

  async updateContent(scriptId: string, files: GScriptFile[]): Promise<GScriptFile[]> {
    try {
      const response = await this.script.projects.updateContent({
        scriptId,
        requestBody: {
          files: files.map((f) => ({ name: f.name, type: f.type, source: f.source })),
        },
      });
      return (response.data.files || []).map((f) => ({
        name: f.name || '',
        type: (f.type || 'SERVER_JS') as GScriptFile['type'],
        source: f.source || '',
      }));
    } catch (err) {
      this.throwApiError(err, 'update script content');
    }
  }

  private toProject(data: script_v1.Schema$Project): GScriptProject {
    const scriptId = data.scriptId!;
    return {
      scriptId,
      title: data.title || 'Untitled',
      parentId: data.parentId || undefined,
      createTime: data.createTime || undefined,
      updateTime: data.updateTime || undefined,
      creator: data.creator?.email || undefined,
      lastModifyUser: data.lastModifyUser?.email || undefined,
      url: `https://script.google.com/d/${scriptId}/edit`,
    };
  }

  private createOAuthClient(): OAuth2Client {
    const oauth2Client = new OAuth2Client(
      GOOGLE_OAUTH_CONFIG.clientId,
      GOOGLE_OAUTH_CONFIG.clientSecret
    );
    oauth2Client.setCredentials({
      access_token: this.credentials.accessToken,
      refresh_token: this.credentials.refreshToken,
      expiry_date: this.credentials.expiryDate,
    });
    return oauth2Client;
  }

  private throwApiError(err: unknown, operation: string): never {
    const code = this.getErrorCode(err);
    const message = this.getErrorMessage(err);
    throw new CliError(code, `Failed to ${operation}: ${message}`);
  }

  private getErrorCode(err: unknown): ErrorCode {
    if (err && typeof err === 'object') {
      const error = err as Record<string, unknown>;
      const code = error.code || error.status;
      if (typeof code === 'number') return httpStatusToErrorCode(code);
    }
    return 'API_ERROR';
  }

  private getErrorMessage(err: unknown): string {
    if (err && typeof err === 'object') {
      const error = err as Record<string, unknown>;
      const code = error.code || error.status;
      if (code === 401) return 'OAuth token expired or invalid';
      if (code === 403) return 'Insufficient permissions for this script project';
      if (code === 404) return 'Script project not found';
      if (code === 429) return 'Rate limit exceeded, please try again later';
      if (error.message && typeof error.message === 'string') return error.message;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
