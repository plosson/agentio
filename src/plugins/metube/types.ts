export interface MetubeCredentials {
  /** The server's base URL, such as https://metube.example.com, without a trailing slash. */
  url: string;
  /** HTTP basic auth in front of MeTube, when the server has one. */
  username?: string;
  password?: string;
}

/** A download as MeTube's `GET /history` returns it (the fields agentio reads). */
export interface MetubeDownload {
  /** The site's own id for the video, such as a YouTube video id. */
  id: string;
  /** MeTube's key for the download: the video's page URL. `/delete` takes this. */
  url: string;
  title: string;
  status: string;
  download_type: string;
  format?: string;
  quality?: string;
  folder?: string | null;
  /** Relative to the download folder; set once the file exists. */
  filename?: string | null;
  size?: number | null;
  percent?: number | null;
  speed?: number | null;
  eta?: number | null;
  msg?: string | null;
  error?: string | null;
  /** Nanoseconds since the epoch, set when the download was queued. */
  timestamp: number;
}

export interface MetubeHistory {
  queue: MetubeDownload[];
  pending: MetubeDownload[];
  done: MetubeDownload[];
}

/** What `POST /add` takes. */
export interface MetubeAddRequest {
  url: string;
  download_type: 'video' | 'audio';
  format: string;
  quality: string;
  folder?: string;
  auto_start: true;
}

/** Where a download stands, as agentio reports it. */
export type MetubeState = 'queued' | 'finished' | 'failed';
