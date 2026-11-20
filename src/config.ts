import { readFile } from 'node:fs/promises';
import { OverleafMcpError } from './errors.js';

export interface OverleafConfig {
  url: string;
  email: string;
  password: string;
  defaultProject?: string;
}

const DEFAULT_OVERLEAF_URL = 'http://localhost:12980';

/**
 * Loads Overleaf CE connection configuration from environment variables.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<OverleafConfig> {
  const rawUrl = env.OVERLEAF_URL?.trim() || DEFAULT_OVERLEAF_URL;
  const url = rawUrl.replace(/\/+$/, '');

  const email = env.OVERLEAF_EMAIL?.trim();
  if (!email) {
    throw new OverleafMcpError(
      'Missing OVERLEAF_EMAIL environment variable.',
      'CONFIG_ERROR'
    );
  }

  let password = env.OVERLEAF_PASSWORD?.trim();
  if (!password && env.OVERLEAF_PASSWORD_FILE?.trim()) {
    const filePath = env.OVERLEAF_PASSWORD_FILE.trim();
    try {
      password = (await readFile(filePath, 'utf8')).trim();
    } catch (err) {
      throw new OverleafMcpError(
        `Failed to read OVERLEAF_PASSWORD_FILE (${filePath}): ${(err as Error).message}`,
        'CONFIG_ERROR'
      );
    }
  }

  if (!password) {
    throw new OverleafMcpError(
      'Missing OVERLEAF_PASSWORD or OVERLEAF_PASSWORD_FILE environment variable.',
      'CONFIG_ERROR'
    );
  }

  const defaultProject = env.OVERLEAF_DEFAULT_PROJECT?.trim() || undefined;

  return { url, email, password, defaultProject };
}
