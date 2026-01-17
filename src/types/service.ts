/**
 * Result of validating service credentials.
 */
export interface ValidationResult {
  valid: boolean;
  info?: string;
  error?: string;
}

/**
 * Common interface for all service clients.
 * Implementations should handle token refresh internally if needed.
 */
export interface ServiceClient {
  /**
   * Validate credentials by making an API call.
   * Should refresh tokens internally if needed before validating.
   * @returns ValidationResult with status and optional info/error
   */
  validate(): Promise<ValidationResult>;
}
