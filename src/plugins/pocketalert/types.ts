export interface PocketAlertCredentials {
  /** The account's API key, from Settings in the Pocket Alert app; sent in the `Token` header. */
  apiKey: string;
}

/** An application as `GET /v1/applications` lists it. */
export interface PocketAlertApplication {
  tid: string;
  name: string;
  color?: string;
  is_active?: boolean;
  created_at?: string;
}

/** What `send` posts to `POST /v1/messages`. */
export interface PocketAlertMessageInput {
  title: string;
  message: string;
  /** Application TID; the server's default application when absent. */
  application_id?: string;
  /** Device TID; every device when absent. */
  device_id?: string;
  /** -2 to 2, or a level name; the application's default when absent. */
  level?: string | number;
}

/** The message the server created, as `POST /v1/messages` returns it. */
export interface PocketAlertMessage {
  tid: string;
  title: string;
  message: string;
  application?: string;
  device?: string;
  created_at?: string;
}
