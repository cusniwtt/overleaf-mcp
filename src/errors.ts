/**
 * Typed error for Overleaf CE MCP operations.
 */
export class OverleafMcpError extends Error {
  readonly code: string;

  constructor(message: string, code = 'OVERLEAF_ERROR') {
    super(message);
    this.name = 'OverleafMcpError';
    this.code = code;
  }
}

/**
 * Redacts explicit secret values as well as Overleaf session cookies and CSRF headers.
 */
export function maskSecrets(text: string, secrets: string[] = []): string {
  let result = String(text ?? '');
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      result = result.split(secret).join('***');
    }
  }
  result = result.replace(/overleaf\.sid=[^;\s]+/gi, 'overleaf.sid=***');
  result = result.replace(/(x-csrf-token:\s*)[^\s;]+/gi, '$1***');
  return result;
}
