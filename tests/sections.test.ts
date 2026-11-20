import { describe, it, expect } from 'vitest';
import {
  parseSections,
  extractSectionContent,
  replaceSectionContent,
} from '../src/latex/sections.js';
import { OverleafMcpError } from '../src/errors.js';

const sampleDoc = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Intro}',
  'First paragraph.',
  '\\subsection{Background}',
  'Details here.',
  '\\section[Short]{Use of \\emph{X} and $a^{2}$}',
  'Math content.',
  '\\subsection{Evaluation}',
  'Eval 1.',
  '\\section*{Acknowledgments}',
  'Thanks!',
  '\\subsection{Evaluation}',
  'Eval 2.',
  '\\end{document}',
].join('\n');

describe('LaTeX sections parser & replacer', () => {
  it('parses nested braces, short titles, and starred headings', () => {
    const sections = parseSections(sampleDoc);
    expect(sections.map((s) => ({ type: s.type, title: s.title }))).toEqual([
      { type: 'section', title: 'Intro' },
      { type: 'subsection', title: 'Background' },
      { type: 'section', title: 'Use of \\emph{X} and $a^{2}$' },
      { type: 'subsection', title: 'Evaluation' },
      { type: 'section', title: 'Acknowledgments' },
      { type: 'subsection', title: 'Evaluation' },
    ]);
  });

  it('extracts and replaces a section including its heading line and subsections', () => {
    const extracted = extractSectionContent(sampleDoc, 'Intro');
    expect(extracted).toBe(
      ['\\section{Intro}', 'First paragraph.', '\\subsection{Background}', 'Details here.'].join('\n')
    );

    const updated = replaceSectionContent(
      sampleDoc,
      'Intro',
      '\\section{Intro}\nNew intro paragraph.'
    );
    expect(extractSectionContent(updated, 'Intro')).toBe(
      '\\section{Intro}\nNew intro paragraph.'
    );
    expect(updated).toContain('\\section[Short]{Use of \\emph{X} and $a^{2}$}');
    expect(updated).toContain('\\end{document}');
  });

  it('rejects ambiguous duplicate titles unless sectionIndex is supplied', () => {
    const sections = parseSections(sampleDoc);
    const evals = sections.filter((s) => s.title === 'Evaluation');
    expect(evals).toHaveLength(2);

    expect(() => extractSectionContent(sampleDoc, 'Evaluation')).toThrow(OverleafMcpError);
    try {
      extractSectionContent(sampleDoc, 'Evaluation');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(String(evals[0].index));
      expect(msg).toContain(String(evals[1].index));
    }

    expect(extractSectionContent(sampleDoc, 'Evaluation', evals[1].index)).toBe(
      '\\subsection{Evaluation}\nEval 2.'
    );

    const replacedSecond = replaceSectionContent(
      sampleDoc,
      'Evaluation',
      '\\subsection{Evaluation}\nUpdated Eval 2.',
      evals[1].index
    );
    expect(extractSectionContent(replacedSecond, 'Evaluation', evals[0].index)).toBe(
      '\\subsection{Evaluation}\nEval 1.'
    );
    expect(replacedSecond).toContain('Updated Eval 2.');
  });

  it('throws OverleafMcpError for unknown sectionTitle or invalid sectionIndex', () => {
    expect(() => extractSectionContent(sampleDoc, 'Nonexistent')).toThrow(OverleafMcpError);
    expect(() => replaceSectionContent(sampleDoc, 'Intro', 'x', 99999)).toThrow(OverleafMcpError);
  });

  it('ignores commented-out headings and preserves blank lines and trailing newlines', () => {
    const withCommentsAndSpacing = [
      '\\documentclass{article}',
      '\\begin{document}',
      '% \\section{Intro}',
      '\\section{Intro}',
      'Body 100\\% valid.',
      '',
      '\\section{Next}',
      'End.',
      '\\end{document}',
      '',
    ].join('\n');

    const sections = parseSections(withCommentsAndSpacing);
    expect(sections.map((s) => s.title)).toEqual(['Intro', 'Next']);

    const replaced = replaceSectionContent(
      withCommentsAndSpacing,
      'Intro',
      '\\section{Intro}\nReplaced body.'
    );
    expect(replaced).toContain('\\section{Intro}\nReplaced body.\n\n\\section{Next}');
    expect(replaced.endsWith('\n')).toBe(true);

    const subfile = '\\section{Sub}\nOld line.\n';
    const replacedSubfile = replaceSectionContent(subfile, 'Sub', '\\section{Sub}\nNew line.');
    expect(replacedSubfile).toBe('\\section{Sub}\nNew line.\n');
  });
});
