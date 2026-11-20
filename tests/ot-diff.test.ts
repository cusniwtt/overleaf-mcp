import { describe, it, expect } from 'vitest';
import { computeOtOps, applyOtOpsLocally } from '../src/overleaf/ot-diff.js';

describe('computeOtOps', () => {
  it('returns empty array when texts are identical', () => {
    expect(computeOtOps('hello', 'hello')).toEqual([]);
  });

  it('computes minimal delete+insert ops around common prefix and suffix', () => {
    const from = '\\section{Intro}\nOld sentence.\n\\end{document}';
    const to = '\\section{Intro}\nNew improved sentence.\n\\end{document}';
    const ops = computeOtOps(from, to);
    expect(applyOtOpsLocally(from, ops)).toBe(to);
    expect(ops.length).toBeLessThanOrEqual(2);
  });

  it('preserves UTF-16 code-unit offsets for Thai text and emoji', () => {
    const from = 'หัวข้อ: ทดสอบ 🚀 จบ';
    const to = 'หัวข้อ: แก้ไข 🚀 จบ';
    const ops = computeOtOps(from, to);
    expect(applyOtOpsLocally(from, ops)).toBe(to);
  });

  it('handles empty-to-nonempty and nonempty-to-empty', () => {
    expect(applyOtOpsLocally('', computeOtOps('', 'abc'))).toBe('abc');
    expect(applyOtOpsLocally('abc', computeOtOps('abc', ''))).toBe('');
  });
});
