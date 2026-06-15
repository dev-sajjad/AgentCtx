import { describe, it, expect } from 'vitest';

import {
  parseClaudeMd,
  isPlaceholderBody,
  validateClaudeMd,
  suggestForClaudeMd,
  upsertSection,
  applySuggestions,
  formatValidation,
  formatSuggestions,
  FACTS_SECTION,
} from '../../src/claudemd/index.js';
import type { MemoryEntry } from '../../src/shared/types.js';

function mem(partial: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: partial.id ?? 'm1',
    layer: partial.layer ?? 'mid',
    content: partial.content ?? 'content',
    tags: partial.tags ?? [],
    project: partial.project ?? 'proj',
    created_at: partial.created_at ?? 1000,
    expires_at: partial.expires_at ?? null,
  };
}

const DOC = `# My Project

Intro line.

## Architecture

Node + SQLite.

### Sub detail

Still architecture.

## Commands

- Build: \`npm run build\`
`;

describe('parseClaudeMd', () => {
  it('extracts the title and preamble', () => {
    const parsed = parseClaudeMd(DOC);
    expect(parsed.title).toBe('My Project');
    expect(parsed.preamble).toContain('Intro line.');
  });

  it('splits on level-2 headings only (### stays with its parent)', () => {
    const parsed = parseClaudeMd(DOC);
    expect(parsed.sections.map((s) => s.heading)).toEqual(['Architecture', 'Commands']);
    expect(parsed.sections[0]!.body).toContain('### Sub detail');
    expect(parsed.sections[0]!.body).toContain('Still architecture.');
  });

  it('returns no sections for a doc without headings', () => {
    expect(parseClaudeMd('just text').sections).toHaveLength(0);
  });
});

describe('isPlaceholderBody', () => {
  it('flags empty, italic, and empty-bullet bodies', () => {
    expect(isPlaceholderBody('')).toBe(true);
    expect(isPlaceholderBody('_describe the stack_')).toBe(true);
    expect(isPlaceholderBody('- Build: `` ')).toBe(true);
    expect(isPlaceholderBody('-')).toBe(true);
  });

  it('does not flag real content', () => {
    expect(isPlaceholderBody('Node + SQLite.')).toBe(false);
    expect(isPlaceholderBody('- Build: `npm run build`')).toBe(false);
  });
});

describe('validateClaudeMd', () => {
  it('reports missing recommended sections as info', () => {
    const result = validateClaudeMd(DOC);
    const msgs = result.issues.map((i) => i.message).join('\n');
    expect(msgs).toContain('Coding conventions');
    expect(msgs).toContain('Off-limits');
    expect(result.sectionCount).toBe(2);
  });

  it('warns on placeholder sections and missing title', () => {
    const doc = '## Architecture\n\n_todo_\n';
    const result = validateClaudeMd(doc);
    const warnings = result.issues.filter((i) => i.severity === 'warning').map((i) => i.message);
    expect(warnings.some((m) => m.includes('placeholder'))).toBe(true);
    expect(warnings.some((m) => m.includes('title'))).toBe(true);
  });

  it('flags an oversized document', () => {
    const big = '# Big\n\n## Notes\n\n' + 'word '.repeat(40000);
    const result = validateClaudeMd(big);
    expect(result.issues.some((i) => i.message.includes('large'))).toBe(true);
  });
});

describe('suggestForClaudeMd', () => {
  const memories = [
    mem({ id: 'a', layer: 'long', content: 'Use port 3000', created_at: 1 }),
    mem({ id: 'b', layer: 'mid', content: 'Auth is JWT', created_at: 5 }),
    mem({ id: 'c', layer: 'short', content: 'ephemeral note', created_at: 9 }),
  ];

  it('prefers durable layers and skips short-term', () => {
    const set = suggestForClaudeMd('# Doc\n', memories);
    expect(set.section).toBe(FACTS_SECTION);
    expect(set.additions).toEqual(['Use port 3000', 'Auth is JWT']);
  });

  it('skips facts already present in the document', () => {
    const set = suggestForClaudeMd('# Doc\n\nAuth is JWT already noted.\n', memories);
    expect(set.additions).toEqual(['Use port 3000']);
  });

  it('honours the limit', () => {
    const set = suggestForClaudeMd('# Doc\n', memories, { limit: 1 });
    expect(set.additions).toHaveLength(1);
  });
});

describe('upsertSection', () => {
  it('appends a new section', () => {
    const out = upsertSection(DOC, 'Off-limits', '- Never edit dist/');
    const parsed = parseClaudeMd(out);
    expect(parsed.sections.map((s) => s.heading)).toContain('Off-limits');
    expect(out).toContain('- Never edit dist/');
  });

  it('replaces an existing section body, case-insensitively', () => {
    const out = upsertSection(DOC, 'architecture', 'Rewritten.');
    const parsed = parseClaudeMd(out);
    const arch = parsed.sections.find((s) => s.heading === 'Architecture')!;
    expect(arch.body).toBe('Rewritten.');
    expect(out).not.toContain('Node + SQLite.');
    // other sections untouched
    expect(parsed.sections.find((s) => s.heading === 'Commands')).toBeDefined();
  });

  it('ends with a single trailing newline', () => {
    const out = upsertSection(DOC, 'New', 'body');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('applySuggestions', () => {
  it('adds bullets under a new section and de-duplicates', () => {
    const doc = '# Doc\n';
    const once = applySuggestions(doc, { section: 'Facts', additions: ['A', 'B'] });
    expect(once).toContain('- A');
    expect(once).toContain('- B');
    const twice = applySuggestions(once, { section: 'Facts', additions: ['B', 'C'] });
    expect(twice.match(/- B/g)).toHaveLength(1);
    expect(twice).toContain('- C');
  });

  it('is a no-op with no additions', () => {
    const doc = '# Doc\n';
    expect(applySuggestions(doc, { section: 'Facts', additions: [] })).toBe(doc);
  });
});

describe('formatters', () => {
  it('formatValidation reports a clean doc', () => {
    const out = formatValidation({ issues: [], tokenCount: 10, sectionCount: 4 });
    expect(out).toContain('no issues');
  });

  it('formatSuggestions handles the empty case', () => {
    expect(formatSuggestions({ section: 'x', additions: [] })).toContain('already covers');
  });
});
