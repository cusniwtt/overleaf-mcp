import { OverleafMcpError } from '../errors.js';

export type LatexSectionType =
  | 'part'
  | 'chapter'
  | 'section'
  | 'subsection'
  | 'subsubsection';

export interface LatexSection {
  type: LatexSectionType;
  title: string;
  index: number;
}

const SECTION_LEVELS: Record<LatexSectionType, number> = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
};

/**
 * Parses LaTeX sectioning commands using brace-balanced scanning.
 */
export function parseSections(content: string): LatexSection[] {
  const sections: LatexSection[] = [];
  const openerRegex = /\\(subsubsection|subsection|section|chapter|part)\*?(?:\[[^\]]*\])?\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = openerRegex.exec(content)) !== null) {
    const startIdx = match.index;
    const type = match[1] as LatexSectionType;
    let depth = 1;
    let i = openerRegex.lastIndex;

    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}' && --depth === 0) {
        break;
      }
      i++;
    }

    if (depth !== 0) continue;

    sections.push({
      type,
      title: content.slice(openerRegex.lastIndex, i).trim(),
      index: startIdx,
    });
    openerRegex.lastIndex = i + 1;
  }

  return sections;
}

function findTargetSectionSpan(
  content: string,
  sectionTitle: string,
  sectionIndex?: number
): { start: number; end: number; target: LatexSection } {
  const sections = parseSections(content);
  const normalized = sectionTitle.trim();

  let target: LatexSection | undefined;
  if (sectionIndex !== undefined) {
    target = sections.find((s) => s.index === sectionIndex && s.title === normalized);
    if (!target) {
      throw new OverleafMcpError(
        `Section "${normalized}" at index ${sectionIndex} not found.`,
        'SECTION_NOT_FOUND'
      );
    }
  } else {
    const matches = sections.filter((s) => s.title === normalized);
    if (matches.length === 0) {
      throw new OverleafMcpError(`Section "${normalized}" not found.`, 'SECTION_NOT_FOUND');
    }
    if (matches.length > 1) {
      const details = matches.map((m) => `${m.type} at index ${m.index}`).join(', ');
      throw new OverleafMcpError(
        `Ambiguous section title "${normalized}" matched ${matches.length} headings (${details}). Pass sectionIndex to disambiguate.`,
        'AMBIGUOUS_SECTION'
      );
    }
    target = matches[0];
  }

  const targetLevel = SECTION_LEVELS[target.type];
  const next = sections.find(
    (s) => s.index > target.index && SECTION_LEVELS[s.type] <= targetLevel
  );
  const endDocIdx = content.lastIndexOf('\\end{document}');
  let end = content.length;
  if (next) {
    end = next.index;
  } else if (endDocIdx !== -1 && endDocIdx > target.index) {
    end = endDocIdx;
  }

  return { start: target.index, end, target };
}

/**
 * Extracts a LaTeX section including its heading line through just before the next
 * equal/higher-level heading, `\end{document}`, or EOF.
 */
export function extractSectionContent(
  content: string,
  sectionTitle: string,
  sectionIndex?: number
): string {
  const { start, end } = findTargetSectionSpan(content, sectionTitle, sectionIndex);
  return content.slice(start, end).trimEnd();
}

/**
 * Replaces a LaTeX section (including its heading line) with `newContent`.
 */
export function replaceSectionContent(
  content: string,
  sectionTitle: string,
  newContent: string,
  sectionIndex?: number
): string {
  const { start, end } = findTargetSectionSpan(content, sectionTitle, sectionIndex);
  const tail = content.slice(end);
  const separator = tail.length > 0 ? '\n' : '';
  return content.slice(0, start) + newContent.trimEnd() + separator + tail;
}
