export interface HiggsfieldCredentials {
  /** The API key as `<key id>:<key secret>`, sent as `Authorization: Key <key>`. */
  key: string;
}

/** Where a request stands (docs.higgsfield.ai/docs/concepts/requests). */
export type RequestState = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled';
export const REQUEST_STATES: readonly RequestState[] = ['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled'];
export const TERMINAL_STATES: readonly RequestState[] = ['completed', 'failed', 'nsfw', 'canceled'];

/** What a submission answers. */
export interface SubmitResponse {
  request_id: string;
  status: RequestState;
  status_url?: string;
  cancel_url?: string;
}

/** `GET /requests/{id}/status`. Outputs sit in `images`, `video`, `audio`, `audios`, or other fields holding `{ url }`. */
export interface RequestStatus {
  request_id: string;
  status: RequestState;
  error?: string | null;
  expires_at?: string;
  [field: string]: unknown;
}

/** `POST /files/generate-upload-url`. */
export interface UploadTicket {
  upload_url: string;
  public_url: string;
  upload_headers?: Record<string, string>;
}

/** A request agentio submitted, kept in the local cache since the API cannot list requests. */
export interface RequestRecord {
  requestId: string;
  model: string;
  createdAt: string;
  status: RequestState;
  error?: string;
  outputs?: string[];
}
