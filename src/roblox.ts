import noblox from "noblox.js";

// Error classification

export enum RobloxErrorType {
  AUTH_EXPIRED = "AUTH_EXPIRED",
  CSRF_FAILED = "CSRF_FAILED",
  INSUFFICIENT_PERMISSIONS = "INSUFFICIENT_PERMISSIONS",
  RATE_LIMITED = "RATE_LIMITED",
  TWO_FA_FAILED = "TWO_FA_FAILED",
  NETWORK_ERROR = "NETWORK_ERROR",
  ROBLOX_API_ERROR = "ROBLOX_API_ERROR",
  SESSION_NOT_INITIALIZED = "SESSION_NOT_INITIALIZED",
}

export class RobloxError extends Error {
  type: RobloxErrorType;
  statusCode?: number;
  retryable: boolean;

  constructor(
    type: RobloxErrorType,
    message: string,
    statusCode?: number,
    retryable = false,
  ) {
    super(message);
    this.name = "RobloxError";
    this.type = type;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

/**
 * Classify a got HTTP response into a typed RobloxError.
 * Returns null if the response represents a 2FA challenge (not an error).
 */
export function classifyHttpError(
  statusCode: number,
  headers: Record<string, string | string[] | undefined>,
  body: string,
  context: string,
): RobloxError | null {
  if (statusCode === 401) {
    return new RobloxError(
      RobloxErrorType.AUTH_EXPIRED,
      `${context}: Roblox session has expired. The cookie needs to be refreshed or replaced.`,
      401,
      false,
    );
  }

  if (statusCode === 403) {
    // 2FA challenge — not an error
    if (headers["rblx-challenge-metadata"]) {
      return null;
    }
    return new RobloxError(
      RobloxErrorType.INSUFFICIENT_PERMISSIONS,
      `${context}: Insufficient permissions.`,
      403,
      false,
    );
  }

  if (statusCode === 429) {
    return new RobloxError(
      RobloxErrorType.RATE_LIMITED,
      `${context}: Rate limited by Roblox API.`,
      429,
      true,
    );
  }

  // Try to extract Roblox error message from body
  let robloxMessage: string | undefined;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.errors && Array.isArray(parsed.errors)) {
      for (const { message } of parsed.errors) {
        if (message) {
          robloxMessage = message;
          break;
        }
      }
    }
  } catch {
    // Body is not JSON
  }

  const detail = robloxMessage ? `: ${robloxMessage}` : "";
  return new RobloxError(
    RobloxErrorType.ROBLOX_API_ERROR,
    `${context}${detail}`,
    statusCode,
    statusCode >= 500,
  );
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("ECONNREFUSED")
    );
  }
  return false;
}

// Session management

export interface HealthStatus {
  authenticated: boolean;
  userId: number | null;
  userName: string | null;
  lastHealthCheck: string | null;
  healthy: boolean;
  uptime: number;
}

export class RobloxSession {
  private cookie: string;
  private totpSecret: string;
  private userId: number | undefined;
  private userName: string | undefined;
  private groupId: number | undefined;
  private healthy = false;
  private lastHealthCheck = 0;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();

  constructor(cookie: string, totpSecret: string) {
    this.cookie = cookie;
    this.totpSecret = totpSecret;
  }

  async init(groupId: number): Promise<void> {
    this.groupId = groupId;

    // Step 1: Validate cookie and get authenticated user
    let currentUser;
    try {
      currentUser = await noblox.setCookie(this.cookie);
    } catch (error) {
      throw new RobloxError(
        RobloxErrorType.AUTH_EXPIRED,
        `Failed to authenticate with Roblox: ${error instanceof Error ? error.message : "Invalid cookie"}`,
      );
    }

    this.userId = currentUser.id;
    this.userName = currentUser.name;

    // Step 2: Verify group membership
    const rank = await noblox.getRankInGroup(groupId, this.userId);
    if (rank === 0) {
      throw new RobloxError(
        RobloxErrorType.INSUFFICIENT_PERMISSIONS,
        `Account ${this.userName} (${this.userId}) is not a member of group ${groupId}`,
      );
    }

    // Step 3: Check group funds access as a secondary signal
    try {
      await noblox.getGroupFunds(groupId);
    } catch {
      console.warn(
        `Warning: Unable to read group funds for group ${groupId}. The account may lack economy permissions.`,
      );
    }

    this.healthy = true;
    this.lastHealthCheck = Date.now();
    console.log(
      `Payout account verified: ${this.userName} [${this.userId}], rank ${rank} in group ${groupId}`,
    );
  }

  getUserId(): number {
    if (this.userId === undefined) {
      throw new RobloxError(
        RobloxErrorType.SESSION_NOT_INITIALIZED,
        "RobloxSession not initialized. Call init() first.",
      );
    }
    return this.userId;
  }

  getCookie(): string {
    return this.cookie;
  }

  getTotpSecret(): string {
    return this.totpSecret;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  markUnhealthy(): void {
    this.healthy = false;
    console.error(
      "ALERT: Roblox session marked unhealthy! Payouts will fail until the cookie is replaced.",
    );
  }

  async validateSession(): Promise<boolean> {
    try {
      await noblox.getAuthenticatedUser();
      this.healthy = true;
      this.lastHealthCheck = Date.now();
      return true;
    } catch (error) {
      if (isNetworkError(error)) {
        // Transient network issue — don't change health status
        console.warn(
          "Health check: network error reaching Roblox API, keeping current health status.",
        );
        throw new RobloxError(
          RobloxErrorType.NETWORK_ERROR,
          `Network error during session validation: ${error instanceof Error ? error.message : "Unknown"}`,
          undefined,
          true,
        );
      }
      // Auth failure (401 or similar)
      this.healthy = false;
      this.lastHealthCheck = Date.now();
      return false;
    }
  }

  async getCsrfToken(): Promise<string> {
    try {
      const token = await noblox.getGeneralToken();
      return token;
    } catch (error) {
      if (isNetworkError(error)) {
        throw new RobloxError(
          RobloxErrorType.NETWORK_ERROR,
          `Network error fetching CSRF token: ${error instanceof Error ? error.message : "Unknown"}`,
          undefined,
          true,
        );
      }
      throw new RobloxError(
        RobloxErrorType.CSRF_FAILED,
        `Failed to obtain CSRF token: ${error instanceof Error ? error.message : "Unknown"}. The session may have expired.`,
      );
    }
  }

  startHealthCheck(intervalMs = 300_000): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      try {
        const valid = await this.validateSession();
        if (!valid) {
          console.error(
            "ALERT: Roblox session has expired! Payouts will fail until cookie is replaced.",
          );
        }
      } catch {
        // Network error — already logged in validateSession()
      }
    }, intervalMs);

    // Allow the process to exit even if the interval is running
    if (this.healthCheckInterval.unref) {
      this.healthCheckInterval.unref();
    }
  }

  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  getHealthStatus(): HealthStatus {
    return {
      authenticated: this.healthy,
      userId: this.userId ?? null,
      userName: this.userName ?? null,
      lastHealthCheck: this.lastHealthCheck
        ? new Date(this.lastHealthCheck).toISOString()
        : null,
      healthy: this.healthy,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  async reinitialize(
    newCookie: string,
    groupId: number,
  ): Promise<void> {
    const previousCookie = this.cookie;
    this.cookie = newCookie;
    try {
      await this.init(groupId);
    } catch (error) {
      // Rollback on failure
      this.cookie = previousCookie;
      throw error;
    }
  }
}
