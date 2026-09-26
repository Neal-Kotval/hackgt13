import {
  SessionStore,
  mergeCookieHeader,
  cookieLooksLikeSession,
  type SessionPayload,
} from "./session-store.ts";

export type EmployeeIdentity = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
};

export type AuthStatus = {
  signedIn: boolean;
  baseUrl: string;
  serverReachable: boolean | null;
  user: EmployeeIdentity | null;
  message: string;
  secureStorage: boolean;
};

export class AuthError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

type FetchLike = typeof fetch;

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "http://127.0.0.1:3000";
  return trimmed;
}

function pickSetCookie(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Desktop Better Auth employee session client.
 * Uses the same /api/auth/* endpoints and session cookies as the web app.
 * Never accepts or forwards AgentCloud agent bearer tokens.
 */
export class DesktopAuthClient {
  private cookieHeader: string | null = null;
  private baseUrl: string;
  private readonly store: SessionStore;
  private readonly fetchImpl: FetchLike;
  private readonly encryptionAvailable: boolean;

  constructor(
    store: SessionStore,
    options: {
      baseUrl?: string;
      fetchImpl?: FetchLike;
      encryptionAvailable?: boolean;
    } = {},
  ) {
    this.store = store;
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ||
        process.env.AGENTCLOUD_URL ||
        process.env.BETTER_AUTH_URL ||
        "http://127.0.0.1:3000",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.encryptionAvailable = options.encryptionAvailable ?? false;
    const loaded = this.store.load();
    if (loaded) {
      this.cookieHeader = loaded.cookieHeader;
      this.baseUrl = normalizeBaseUrl(loaded.baseUrl || this.baseUrl);
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = normalizeBaseUrl(url);
  }

  hasLocalSession(): boolean {
    return Boolean(this.cookieHeader && cookieLooksLikeSession(this.cookieHeader));
  }

  private persist(): void {
    if (!this.cookieHeader || !cookieLooksLikeSession(this.cookieHeader)) {
      this.store.clear();
      this.cookieHeader = null;
      return;
    }
    const payload: SessionPayload = {
      cookieHeader: this.cookieHeader,
      baseUrl: this.baseUrl,
      updatedAt: new Date().toISOString(),
    };
    this.store.save(payload);
  }

  private applySetCookie(response: Response): void {
    const setCookies = pickSetCookie(response);
    if (setCookies.length === 0) return;
    this.cookieHeader = mergeCookieHeader(this.cookieHeader, setCookies);
    this.persist();
  }

  async signIn(email: string, password: string): Promise<EmployeeIdentity> {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      throw new AuthError("Email and password are required.");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/auth/sign-in/email`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: this.baseUrl,
          },
          body: JSON.stringify({ email: trimmedEmail, password }),
        },
      );
    } catch {
      throw new AuthError(
        `Cannot reach AgentCloud at ${this.baseUrl}. Start the web app (just / just dev) first.`,
      );
    }

    this.applySetCookie(response);

    if (!response.ok) {
      let detail = "Sign-in failed. Check your email and password.";
      try {
        const body = (await response.json()) as {
          message?: string;
          code?: string;
        };
        if (body.code === "EMAIL_NOT_VERIFIED") {
          detail = "Verify your email in the web app first, then sign in here.";
        } else if (typeof body.message === "string" && body.message) {
          detail = body.message;
        }
      } catch {
        // keep default
      }
      throw new AuthError(detail, response.status);
    }

    if (!this.hasLocalSession()) {
      throw new AuthError(
        "Sign-in succeeded but no session cookie was returned. Check Better Auth configuration.",
      );
    }

    const identity = await this.getSession();
    if (!identity) {
      throw new AuthError("Signed in but session identity could not be loaded.");
    }
    return identity;
  }

  async signOut(): Promise<void> {
    if (this.cookieHeader) {
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}/api/auth/sign-out`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: this.baseUrl,
              cookie: this.cookieHeader,
            },
            body: JSON.stringify({}),
          },
        );
        this.applySetCookie(response);
      } catch {
        // Always clear local session even if the server is unreachable.
      }
    }
    this.cookieHeader = null;
    this.store.clear();
  }

  async getSession(): Promise<EmployeeIdentity | null> {
    if (!this.cookieHeader) return null;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/auth/get-session`, {
        method: "GET",
        headers: {
          cookie: this.cookieHeader,
          origin: this.baseUrl,
        },
      });
    } catch {
      return null;
    }

    this.applySetCookie(response);

    if (response.status === 401 || response.status === 403) {
      this.cookieHeader = null;
      this.store.clear();
      return null;
    }

    if (!response.ok) return null;

    const body = (await response.json()) as {
      user?: {
        id?: string;
        name?: string;
        email?: string;
        emailVerified?: boolean;
      } | null;
      session?: unknown;
    } | null;

    if (!body?.user?.id || !body.user.email) {
      // Expired / revoked session — clear local copy so relaunch does not restore it.
      this.cookieHeader = null;
      this.store.clear();
      return null;
    }

    return {
      id: body.user.id,
      name: body.user.name || body.user.email,
      email: body.user.email,
      emailVerified: Boolean(body.user.emailVerified),
    };
  }

  /**
   * Call a protected human API with the employee session cookie only.
   * Never attaches Authorization: Bearer (agent tokens stay on the agent path).
   */
  async fetchHuman(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = path.startsWith("http")
      ? path
      : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

    const headers = new Headers(init.headers);
    if (headers.has("authorization")) {
      throw new AuthError(
        "Employee session requests must not carry Authorization headers. Agent tokens are separate.",
      );
    }
    if (this.cookieHeader) {
      headers.set("cookie", this.cookieHeader);
    }
    if (!headers.has("origin")) {
      headers.set("origin", this.baseUrl);
    }

    const response = await this.fetchImpl(url, { ...init, headers });
    this.applySetCookie(response);
    return response;
  }

  async status(): Promise<AuthStatus> {
    const secureStorage = this.encryptionAvailable;
    if (!this.cookieHeader) {
      return {
        signedIn: false,
        baseUrl: this.baseUrl,
        serverReachable: null,
        user: null,
        message: `Sign in with your AgentCloud employee account (${this.baseUrl}).`,
        secureStorage,
      };
    }

    let serverReachable: boolean | null = true;
    let user: EmployeeIdentity | null = null;
    try {
      user = await this.getSession();
    } catch {
      serverReachable = false;
    }

    if (!user) {
      return {
        signedIn: false,
        baseUrl: this.baseUrl,
        serverReachable,
        user: null,
        message: serverReachable === false
          ? `Cannot reach AgentCloud at ${this.baseUrl}.`
          : "Session expired or revoked. Sign in again.",
        secureStorage,
      };
    }

    return {
      signedIn: true,
      baseUrl: this.baseUrl,
      serverReachable: true,
      user,
      message: `Signed in as ${user.name} (${user.email})`,
      secureStorage,
    };
  }
}
