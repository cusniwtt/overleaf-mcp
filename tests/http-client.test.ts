import { describe, it, expect } from 'vitest';
import { OverleafHttpClient } from '../src/overleaf/http-client.js';
import type { OverleafConfig } from '../src/config.js';

const baseConfig: OverleafConfig = {
  url: 'http://localhost:12980',
  email: 'user@example.com',
  password: 'super-secret-password',
};

function makeHeaders(entries: Record<string, string | string[]>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) {
      for (const item of v) h.append(k, item);
    } else {
      h.set(k, v);
    }
  }
  return h;
}

describe('OverleafHttpClient', () => {
  it('logs in via GET /login + POST /login and fetches /user/projects', async () => {
    const calls: Array<{ url: string; method: string; cookie?: string; csrf?: string }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const reqHeaders = new Headers(init?.headers);
      calls.push({
        url,
        method,
        cookie: reqHeaders.get('cookie') ?? undefined,
        csrf: reqHeaders.get('x-csrf-token') ?? undefined,
      });

      if (url.endsWith('/login') && method === 'GET') {
        return new Response(
          '<meta name="ol-csrfToken" content="csrf1"><input name="_csrf" type="hidden" value="csrf1">',
          {
            status: 200,
            headers: makeHeaders({
              'set-cookie': 'overleaf.sid=sid1; Path=/; HttpOnly',
              'content-type': 'text/html',
            }),
          }
        );
      }

      if (url.endsWith('/login') && method === 'POST') {
        expect(reqHeaders.get('cookie')).toContain('overleaf.sid=sid1');
        return new Response(JSON.stringify({ redir: '/project' }), {
          status: 200,
          headers: makeHeaders({
            'set-cookie': 'overleaf.sid=sid2; Path=/; HttpOnly',
            'content-type': 'application/json',
          }),
        });
      }

      if (url.endsWith('/project') && method === 'GET') {
        return new Response('<meta name="ol-csrfToken" content="csrf2">', {
          status: 200,
          headers: makeHeaders({ 'content-type': 'text/html' }),
        });
      }

      if (url.endsWith('/user/projects') && method === 'GET') {
        expect(reqHeaders.get('cookie')).toContain('overleaf.sid=sid2');
        return new Response(
          JSON.stringify({
            projects: [{ _id: 'p1', name: 'Paper One', accessLevel: 'owner' }],
          }),
          { status: 200, headers: makeHeaders({ 'content-type': 'application/json' }) }
        );
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };

    const client = new OverleafHttpClient(baseConfig, fakeFetch);
    const projects = await client.listProjects();
    expect(projects).toEqual([{ id: 'p1', name: 'Paper One', accessLevel: 'owner' }]);
    expect(client.getCookieHeader()).toContain('overleaf.sid=sid2');
    expect(calls.some((c) => c.url.endsWith('/login') && c.method === 'POST')).toBe(true);
  });

  it('recovers automatically once when session expires with 401 or redirect to /login', async () => {
    let loginCount = 0;
    let projectAttempts = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/login') && method === 'GET') {
        loginCount++;
        return new Response(`<input name="_csrf" type="hidden" value="csrf-${loginCount}">`, {
          status: 200,
          headers: makeHeaders({ 'set-cookie': `overleaf.sid=sid-${loginCount}; Path=/` }),
        });
      }
      if (url.endsWith('/login') && method === 'POST') {
        return new Response(null, {
          status: 302,
          headers: makeHeaders({
            location: '/project',
            'set-cookie': `overleaf.sid=auth-${loginCount}; Path=/`,
          }),
        });
      }
      if (url.endsWith('/project') && method === 'GET') {
        return new Response(`<meta name="ol-csrfToken" content="csrf-authed-${loginCount}">`, {
          status: 200,
        });
      }
      if (url.endsWith('/user/projects') && method === 'GET') {
        projectAttempts++;
        if (projectAttempts === 1) {
          return new Response(null, { status: 302, headers: makeHeaders({ location: '/login' }) });
        }
        return new Response(JSON.stringify({ projects: [{ _id: 'p2', name: 'Recovered', accessLevel: 'owner' }] }), {
          status: 200,
          headers: makeHeaders({ 'content-type': 'application/json' }),
        });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    };

    const client = new OverleafHttpClient(baseConfig, fakeFetch);
    const projects = await client.listProjects();
    expect(loginCount).toBe(2);
    expect(projects).toEqual([{ id: 'p2', name: 'Recovered', accessLevel: 'owner' }]);
  });

  it('masks password and cookies when login fails', async () => {
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/login') && method === 'GET') {
        return new Response('<input name="_csrf" type="hidden" value="csrf1">', {
          status: 200,
          headers: makeHeaders({ 'set-cookie': 'overleaf.sid=secret-sid-123; Path=/' }),
        });
      }
      if (url.endsWith('/login') && method === 'POST') {
        return new Response('Invalid super-secret-password for overleaf.sid=secret-sid-123', { status: 401 });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    };

    const client = new OverleafHttpClient(baseConfig, fakeFetch);
    let errMsg = '';
    try {
      await client.listProjects();
    } catch (err) {
      errMsg = (err as Error).message;
    }
    expect(errMsg).not.toBe('');
    expect(errMsg).not.toContain('super-secret-password');
    expect(errMsg).not.toContain('secret-sid-123');
  });

  it('sends x-csrf-token on createFolder, createDoc, and compileProject and fetches logText', async () => {
    const csrfSeen: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const h = new Headers(init?.headers);

      if (url.endsWith('/login') && method === 'GET') {
        return new Response('<input name="_csrf" type="hidden" value="csrf-login">', {
          status: 200,
          headers: makeHeaders({ 'set-cookie': 'overleaf.sid=sid1; Path=/' }),
        });
      }
      if (url.endsWith('/login') && method === 'POST') {
        return new Response(JSON.stringify({ redir: '/project' }), { status: 200 });
      }
      if (url.endsWith('/project') && method === 'GET') {
        return new Response('<meta name="ol-csrfToken" content="csrf-session">', { status: 200 });
      }
      if (url.endsWith('/project/p1/folder') && method === 'POST') {
        csrfSeen.push(h.get('x-csrf-token') ?? '');
        return new Response(JSON.stringify({ _id: 'f1', name: 'sections' }), { status: 200 });
      }
      if (url.endsWith('/project/p1/doc') && method === 'POST') {
        csrfSeen.push(h.get('x-csrf-token') ?? '');
        return new Response(JSON.stringify({ _id: 'd1', name: 'intro.tex' }), { status: 200 });
      }
      if (url.endsWith('/project/p1/compile') && method === 'POST') {
        csrfSeen.push(h.get('x-csrf-token') ?? '');
        return new Response(
          JSON.stringify({
            status: 'failure',
            outputFiles: [
              { type: 'log', path: 'output.log', url: '/project/p1/build/b1/output/output.log' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/project/p1/build/b1/output/output.log') && method === 'GET') {
        return new Response('! Undefined control sequence.\nl.10 \\badcmd', { status: 200 });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    };

    const client = new OverleafHttpClient(baseConfig, fakeFetch);
    const folder = await client.createFolder('p1', 'sections', 'root-f');
    const doc = await client.createDoc('p1', 'intro.tex', folder._id);
    const compiled = await client.compileProject('p1', { rootDocId: doc._id });

    expect(folder).toEqual({ _id: 'f1', name: 'sections' });
    expect(doc).toEqual({ _id: 'd1', name: 'intro.tex' });
    expect(csrfSeen).toEqual(['csrf-session', 'csrf-session', 'csrf-session']);
    expect(compiled.status).toBe('failure');
    expect(compiled.logText).toContain('! Undefined control sequence.');
  });
});
