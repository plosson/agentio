export interface PagerioCredentials {
  /** The pager URL, `https://<host>/p/<token>`. It is the only secret: anyone who has it can page its owner. */
  url: string;
}

/** What `send` posts to the pager URL. Every field is optional; the server applies the limits. */
export interface PagerioPageInput {
  title?: string;
  message?: string;
  /** Markdown, shown on the page view only. */
  details?: string;
  /** An http(s) link the notification opens. */
  url?: string;
  /** Groups related notifications on the device. */
  group?: string;
}

/** The server's `202 Accepted` answer. */
export interface PagerioSentPage {
  id: string;
  status: string;
  /** A web page that shows the whole page, details included. */
  view_url: string;
}
