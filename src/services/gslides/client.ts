import { slides, type slides_v1 } from '@googleapis/slides';
import { drive, type drive_v3 } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
import { CliError, httpStatusToErrorCode, type ErrorCode } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { GOOGLE_OAUTH_CONFIG } from '../../config/credentials';
import type {
  GSlidesCredentials,
  GSlidesListOptions,
  GSlidesListItem,
  GSlidesPresentation,
  GSlidesSlideInfo,
  GSlidesSlideContent,
  GSlidesElement,
  GSlidesCreateResult,
  GSlidesBatchResult,
} from '../../types/gslides';

export class GSlidesClient implements ServiceClient {
  private credentials: GSlidesCredentials;
  private slides: slides_v1.Slides;
  private drive: drive_v3.Drive;

  constructor(credentials: GSlidesCredentials) {
    this.credentials = credentials;
    const auth = this.createOAuthClient();
    this.slides = slides({ version: 'v1', auth: auth as any });
    this.drive = drive({ version: 'v3', auth: auth as any });
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.drive.files.list({
        pageSize: 1,
        q: "mimeType='application/vnd.google-apps.presentation'",
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

  async list(options: GSlidesListOptions = {}): Promise<GSlidesListItem[]> {
    const { limit = 10, query } = options;

    try {
      let q = "mimeType='application/vnd.google-apps.presentation' and trashed=false";
      if (query) q += ` and ${query}`;

      const response = await this.drive.files.list({
        pageSize: Math.min(limit, 100),
        q,
        fields: 'files(id,name,owners,createdTime,modifiedTime,webViewLink)',
        orderBy: 'modifiedTime desc',
      });

      return (response.data.files || []).map((file) => ({
        id: file.id!,
        title: file.name || 'Untitled',
        owner: file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress || undefined,
        createdTime: file.createdTime || undefined,
        modifiedTime: file.modifiedTime || undefined,
        webViewLink: file.webViewLink || `https://docs.google.com/presentation/d/${file.id}`,
      }));
    } catch (err) {
      this.throwApiError(err, 'list presentations');
    }
  }

  async metadata(idOrUrl: string): Promise<GSlidesPresentation> {
    const presentationId = this.extractPresentationId(idOrUrl);

    try {
      const response = await this.slides.presentations.get({ presentationId });
      const data = response.data;
      const pageSize = data.pageSize;

      const slideInfos: GSlidesSlideInfo[] = (data.slides || []).map((slide, index) => ({
        index,
        objectId: slide.objectId || '',
        title: this.extractSlideTitle(slide) || undefined,
      }));

      return {
        id: data.presentationId!,
        title: data.title || 'Untitled',
        url: `https://docs.google.com/presentation/d/${data.presentationId}`,
        slideCount: slideInfos.length,
        width: pageSize?.width?.magnitude ?? undefined,
        height: pageSize?.height?.magnitude ?? undefined,
        slides: slideInfos,
      };
    } catch (err) {
      this.throwApiError(err, 'get presentation metadata');
    }
  }

  async get(idOrUrl: string, slideIndex?: number): Promise<GSlidesSlideContent[]> {
    const presentationId = this.extractPresentationId(idOrUrl);

    try {
      const response = await this.slides.presentations.get({ presentationId });
      const allSlides = response.data.slides || [];

      if (slideIndex !== undefined) {
        if (slideIndex < 0 || slideIndex >= allSlides.length) {
          throw new CliError(
            'INVALID_PARAMS',
            `Slide index ${slideIndex} out of range (0–${allSlides.length - 1})`,
            `Use --slide 0 to ${allSlides.length - 1}`
          );
        }
        return [this.parseSlide(allSlides[slideIndex], slideIndex)];
      }

      return allSlides.map((slide, i) => this.parseSlide(slide, i));
    } catch (err) {
      if (err instanceof CliError) throw err;
      this.throwApiError(err, 'get slide content');
    }
  }

  async create(title: string): Promise<GSlidesCreateResult> {
    try {
      const response = await this.slides.presentations.create({
        requestBody: { title },
      });
      return {
        id: response.data.presentationId!,
        title: response.data.title || title,
        url: `https://docs.google.com/presentation/d/${response.data.presentationId}`,
      };
    } catch (err) {
      this.throwApiError(err, 'create presentation');
    }
  }

  async copy(idOrUrl: string, newTitle: string, parentFolderId?: string): Promise<GSlidesCreateResult> {
    const presentationId = this.extractPresentationId(idOrUrl);

    try {
      const response = await this.drive.files.copy({
        fileId: presentationId,
        requestBody: {
          name: newTitle,
          parents: parentFolderId ? [parentFolderId] : undefined,
        },
        fields: 'id,name,webViewLink',
      });
      return {
        id: response.data.id!,
        title: response.data.name || newTitle,
        url: response.data.webViewLink || `https://docs.google.com/presentation/d/${response.data.id}`,
      };
    } catch (err) {
      this.throwApiError(err, 'copy presentation');
    }
  }

  async export(
    idOrUrl: string,
    format: 'pptx' | 'pdf' | 'odp'
  ): Promise<{ data: Buffer; mimeType: string }> {
    const presentationId = this.extractPresentationId(idOrUrl);

    const formatMap: Record<string, string> = {
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      pdf: 'application/pdf',
      odp: 'application/vnd.oasis.opendocument.presentation',
    };
    const mimeType = formatMap[format];

    try {
      const response = await this.drive.files.export(
        { fileId: presentationId, mimeType },
        { responseType: 'arraybuffer' }
      );
      return { data: Buffer.from(response.data as ArrayBuffer), mimeType };
    } catch (err) {
      this.throwApiError(err, 'export presentation');
    }
  }

  async batch(idOrUrl: string, requests: slides_v1.Schema$Request[]): Promise<GSlidesBatchResult> {
    const presentationId = this.extractPresentationId(idOrUrl);

    if (!Array.isArray(requests) || requests.length === 0) {
      throw new CliError('INVALID_PARAMS', 'requests must be a non-empty array');
    }

    try {
      const response = await this.slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests },
      });
      return {
        replies: response.data.replies?.length ?? 0,
        presentationId,
      };
    } catch (err) {
      this.throwApiError(err, 'execute batch update');
    }
  }

  private parseSlide(slide: slides_v1.Schema$Page, index: number): GSlidesSlideContent {
    const elements: GSlidesElement[] = [];

    for (const element of slide.pageElements || []) {
      if (element.shape?.text) {
        const text = this.extractTextContent(element.shape.text);
        if (text) elements.push({ type: 'text', text });
      }
    }

    return {
      index,
      objectId: slide.objectId || '',
      elements,
      notes: this.extractNotes(slide),
    };
  }

  private extractNotes(slide: slides_v1.Schema$Page): string {
    const notesPage = slide.slideProperties?.notesPage;
    if (!notesPage) return '';
    for (const element of notesPage.pageElements || []) {
      if (element.shape?.placeholder?.type === 'BODY' && element.shape.text) {
        const text = this.extractTextContent(element.shape.text);
        if (text) return text;
      }
    }
    return '';
  }

  private extractSlideTitle(slide: slides_v1.Schema$Page): string | null {
    for (const element of slide.pageElements || []) {
      const type = element.shape?.placeholder?.type;
      if ((type === 'TITLE' || type === 'CENTERED_TITLE') && element.shape?.text) {
        return this.extractTextContent(element.shape.text);
      }
    }
    return null;
  }

  private extractTextContent(textContent: slides_v1.Schema$TextContent): string {
    return (textContent.textElements || [])
      .map((el) => el.textRun?.content || '')
      .join('')
      .replace(/\n$/, '')
      .trim();
  }

  private extractPresentationId(idOrUrl: string): string {
    const urlMatch = idOrUrl.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];
    const idMatch = idOrUrl.match(/id=([a-zA-Z0-9_-]+)/);
    if (idMatch) return idMatch[1];
    return idOrUrl;
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
      if (code === 403) return 'Insufficient permissions to access this presentation';
      if (code === 404) return 'Presentation not found';
      if (code === 429) return 'Rate limit exceeded, please try again later';
      if (error.message && typeof error.message === 'string') return error.message;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
