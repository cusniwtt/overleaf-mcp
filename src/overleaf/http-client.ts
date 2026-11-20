import type { OverleafConfig } from '../config.js';
import { OverleafMcpError, maskSecrets } from '../errors.js';

export interface ProjectSummary {
  id: string;
  name: string;
  accessLevel: string;
}

export interface CompileOutputFile {
  path: string;
  url: string;
  type: string;
  build?: string;
}

export interface CompileResult {
  status: string;
  outputFiles: CompileOutputFile[];
  logText?: string;
}

function extractCsrfToken(html: string): string | undefined {
  const metaMatch =
    html.match(/<meta\b[^>]*\bname=["']ol-csrfToken["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i) ??
    html.match(/<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']ol-csrfToken["'][^>]*>/i);
  if (metaMatch?.[1]) return metaMatch[1];

  const inputMatch =
    html.match(/<input\b[^>]*\bname=["']_csrf["'][^>]*\bvalue=["']([^"']+)["'][^>]*>/i) ??
    html.match(/<input\b[^>]*\bvalue=["']([^"']+)["'][^>]*\bname=["']_csrf["'][^>]*>/i);
  return inputMatch?.[1];
}

/**
 * Authenticated HTTP client for Overleaf Community Edition web endpoints.
 */
export class OverleafHttpClient {
  private readonly config: OverleafConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly cookies = new Map<string, string>();
  private csrfToken: string | undefined;
  private authenticated = false;
  private loginPromise: Promise<void> | undefined;

  constructor(config: OverleafConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  private secretsList(): string[] {
    const secrets = [this.config.password];
    if (this.csrfToken) secrets.push(this.csrfToken);
    for (const val of this.cookies.values()) {
      if (val) secrets.push(val);
    }
    return secrets;
  }

  private redact(text: string): string {
    return maskSecrets(text, this.secretsList());
  }

  private updateCookies(headers: Headers): void {
    const rawSetCookies =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : headers.get('set-cookie')
          ? [headers.get('set-cookie') as string]
          : [];

    for (const raw of rawSetCookies) {
      const pair = raw.split(';', 1)[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  getCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  invalidateSession(): void {
    this.authenticated = false;
    this.csrfToken = undefined;
    this.cookies.clear();
  }

  async ensureAuthenticated(): Promise<void> {
    if (this.authenticated && this.cookies.size > 0) return;
    if (!this.loginPromise) {
      this.loginPromise = this.performLogin().finally(() => {
        this.loginPromise = undefined;
      });
    }
    await this.loginPromise;
  }

  private async performLogin(): Promise<void> {
    this.invalidateSession();

    const loginPageRes = await this.fetchImpl(`${this.config.url}/login`, {
      method: 'GET',
      redirect: 'manual',
    });
    this.updateCookies(loginPageRes.headers);
    const loginHtml = await loginPageRes.text();
    const loginCsrf = extractCsrfToken(loginHtml);
    if (!loginCsrf) {
      throw new OverleafMcpError(
        `Failed to extract CSRF token from ${this.config.url}/login (status ${loginPageRes.status})`,
        'AUTH_ERROR'
      );
    }
    this.csrfToken = loginCsrf;

    const loginRes = await this.fetchImpl(`${this.config.url}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/html',
        'x-csrf-token': loginCsrf,
        ...(this.getCookieHeader() ? { cookie: this.getCookieHeader() } : {}),
      },
      body: JSON.stringify({
        _csrf: loginCsrf,
        email: this.config.email,
        password: this.config.password,
      }),
    });
    this.updateCookies(loginRes.headers);

    if (loginRes.status >= 300 && loginRes.status < 400) {
      const location = loginRes.headers.get('location') ?? '';
      if (location.includes('/login')) {
        throw new OverleafMcpError(
          'Overleaf login rejected credentials (redirected back to /login).',
          'AUTH_ERROR'
        );
      }
    } else if (!loginRes.ok) {
      const body = this.redact(await loginRes.text());
      throw new OverleafMcpError(
        `Overleaf login failed with HTTP ${loginRes.status}: ${body}`,
        'AUTH_ERROR'
      );
    } else {
      const text = await loginRes.text();
      if (text.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(text) as { redir?: string; message?: { text?: string } | string };
          if (!parsed.redir && parsed.message) {
            const msg = typeof parsed.message === 'string' ? parsed.message : parsed.message.text ?? 'Login failed';
            throw new OverleafMcpError(`Overleaf login failed: ${this.redact(msg)}`, 'AUTH_ERROR');
          }
        } catch (err) {
          if (err instanceof OverleafMcpError) throw err;
        }
      }
    }

    // Fetch /project to refresh the authenticated session's CSRF token
    const projectPageRes = await this.fetchImpl(`${this.config.url}/project`, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        ...(this.getCookieHeader() ? { cookie: this.getCookieHeader() } : {}),
      },
    });
    this.updateCookies(projectPageRes.headers);
    if (projectPageRes.status === 302 && (projectPageRes.headers.get('location') ?? '').includes('/login')) {
      throw new OverleafMcpError(
        'Overleaf session was not established after login.',
        'AUTH_ERROR'
      );
    }
    const projectHtml = await projectPageRes.text();
    const nextCsrf = extractCsrfToken(projectHtml);
    if (nextCsrf) {
      this.csrfToken = nextCsrf;
    }
    this.authenticated = true;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    allowRetry = true
  ): Promise<Response> {
    await this.ensureAuthenticated();

    const url = path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `${this.config.url}${path.startsWith('/') ? path : `/${path}`}`;

    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) headers.set('cookie', cookieHeader);
    if (method !== 'GET' && method !== 'HEAD' && this.csrfToken && !headers.has('x-csrf-token')) {
      headers.set('x-csrf-token', this.csrfToken);
    }

    const res = await this.fetchImpl(url, {
      ...init,
      method,
      headers,
      redirect: 'manual',
    });
    this.updateCookies(res.headers);

    const location = res.headers.get('location') ?? '';
    const isAuthRedirect = res.status >= 300 && res.status < 400 && location.includes('/login');
    if ((res.status === 401 || res.status === 403 || isAuthRedirect) && allowRetry) {
      this.invalidateSession();
      return this.request(path, init, false);
    }

    if (!res.ok) {
      const body = this.redact(await res.text());
      throw new OverleafMcpError(
        `Overleaf HTTP ${method} ${path} failed (${res.status}): ${body}`,
        res.status === 401 || res.status === 403 ? 'AUTH_ERROR' : 'HTTP_ERROR'
      );
    }

    return res;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const res = await this.request('/user/projects', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const data = (await res.json()) as {
      projects?: Array<{ _id?: string; id?: string; name: string; accessLevel?: string }>;
    };
    return (data.projects ?? []).map((p) => ({
      id: p._id ?? p.id ?? '',
      name: p.name,
      accessLevel: p.accessLevel ?? 'unknown',
    }));
  }

  async createFolder(
    projectId: string,
    name: string,
    parentFolderId: string
  ): Promise<{ _id: string; name: string }> {
    const res = await this.request(`/project/${encodeURIComponent(projectId)}/folder`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        name,
        parent_folder_id: parentFolderId,
      }),
    });
    return (await res.json()) as { _id: string; name: string };
  }

  async createDoc(
    projectId: string,
    name: string,
    parentFolderId: string
  ): Promise<{ _id: string; name: string }> {
    const res = await this.request(`/project/${encodeURIComponent(projectId)}/doc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        name,
        parent_folder_id: parentFolderId,
      }),
    });
    return (await res.json()) as { _id: string; name: string };
  }

  async compileProject(
    projectId: string,
    options?: { rootDocId?: string }
  ): Promise<CompileResult> {
    const body: Record<string, unknown> = { draft: false };
    if (options?.rootDocId) {
      body.rootDoc_id = options.rootDocId;
    }

    const res = await this.request(`/project/${encodeURIComponent(projectId)}/compile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as {
      status?: string;
      outputFiles?: CompileOutputFile[];
    };
    const outputFiles = data.outputFiles ?? [];
    const logFile = outputFiles.find(
      (f) => f.type === 'log' || f.path.endsWith('.log')
    );

    let logText: string | undefined;
    if (logFile?.url) {
      try {
        const logRes = await this.request(logFile.url, { method: 'GET' });
        logText = await logRes.text();
      } catch {
        logText = undefined;
      }
    }

    return {
      status: data.status ?? 'unknown',
      outputFiles,
      logText,
    };
  }
}
