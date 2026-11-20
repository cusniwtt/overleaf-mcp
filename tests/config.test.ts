import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { maskSecrets } from '../src/errors.js';

describe('loadConfig', () => {
  it('defaults OVERLEAF_URL to http://localhost:12980 and trims trailing slash', async () => {
    const cfg = await loadConfig({
      OVERLEAF_EMAIL: 'user@example.com',
      OVERLEAF_PASSWORD: 'secret-pass',
    });
    expect(cfg).toEqual({
      url: 'http://localhost:12980',
      email: 'user@example.com',
      password: 'secret-pass',
      defaultProject: undefined,
    });
  });

  it('reads password from OVERLEAF_PASSWORD_FILE and trims whitespace', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ol-cfg-'));
    const pwFile = path.join(dir, 'pw.txt');
    await writeFile(pwFile, 'file-secret\n', 'utf8');
    const cfg = await loadConfig({
      OVERLEAF_URL: 'http://127.0.0.1:12980/',
      OVERLEAF_EMAIL: 'u@example.com',
      OVERLEAF_PASSWORD_FILE: pwFile,
      OVERLEAF_DEFAULT_PROJECT: 'My Paper',
    });
    expect(cfg.url).toBe('http://127.0.0.1:12980');
    expect(cfg.password).toBe('file-secret');
    expect(cfg.defaultProject).toBe('My Paper');
  });

  it('throws clear error when email or password is missing', async () => {
    await expect(loadConfig({})).rejects.toThrow(/OVERLEAF_EMAIL/);
    await expect(loadConfig({ OVERLEAF_EMAIL: 'u@example.com' })).rejects.toThrow(/OVERLEAF_PASSWORD/);
  });
});

describe('maskSecrets', () => {
  it('redacts secret strings and overleaf.sid cookie values', () => {
    const out = maskSecrets(
      'Auth failed for pw=supersecret overleaf.sid=s%3Aabc.xyz; csrf=tok123',
      ['supersecret', 'tok123']
    );
    expect(out).not.toContain('supersecret');
    expect(out).not.toContain('tok123');
    expect(out).not.toContain('s%3Aabc.xyz');
    expect(out).toContain('***');
  });
});
