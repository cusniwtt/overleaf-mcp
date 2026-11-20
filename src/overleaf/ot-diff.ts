import type { OtOp } from './socket09-client.js';

export type { OtOp };

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Computes minimal UTF-16 ShareJS OT operations transforming `fromText` into `toText`.
 */
export function computeOtOps(fromText: string, toText: string): OtOp[] {
  if (fromText === toText) return [];

  const minLen = Math.min(fromText.length, toText.length);
  let prefix = 0;
  while (prefix < minLen && fromText.charCodeAt(prefix) === toText.charCodeAt(prefix)) {
    prefix++;
  }
  if (
    prefix > 0 &&
    prefix < minLen &&
    isLowSurrogate(fromText.charCodeAt(prefix)) &&
    isHighSurrogate(fromText.charCodeAt(prefix - 1))
  ) {
    prefix--;
  }

  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    fromText.charCodeAt(fromText.length - 1 - suffix) ===
      toText.charCodeAt(toText.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (
    suffix > 0 &&
    suffix < maxSuffix &&
    isHighSurrogate(fromText.charCodeAt(fromText.length - suffix - 1)) &&
    isLowSurrogate(fromText.charCodeAt(fromText.length - suffix))
  ) {
    suffix--;
  }

  const fromMid = fromText.slice(prefix, fromText.length - suffix);
  const toMid = toText.slice(prefix, toText.length - suffix);

  const ops: OtOp[] = [];
  if (fromMid.length > 0) {
    ops.push({ p: prefix, d: fromMid });
  }
  if (toMid.length > 0) {
    ops.push({ p: prefix, i: toMid });
  }
  return ops;
}

/**
 * Applies ShareJS OT operations sequentially in memory (for tests and verification).
 */
export function applyOtOpsLocally(text: string, ops: OtOp[]): string {
  let current = text;
  for (const op of ops) {
    if ('d' in op) {
      if (current.slice(op.p, op.p + op.d.length) !== op.d) {
        throw new Error(`Delete mismatch at position ${op.p}`);
      }
      current = current.slice(0, op.p) + current.slice(op.p + op.d.length);
    } else {
      current = current.slice(0, op.p) + op.i + current.slice(op.p);
    }
  }
  return current;
}
