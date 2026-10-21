import { describe, expect, it } from 'vitest';
import { CHUNK_CHARS, MAX_TEXT_CHUNKS, textChunks, titleChunk, urlWords } from './chunk';

describe('urlWords', () => {
  it('keeps readable path/query words, drops ids, hex, numbers and extensions', () => {
    expect(
      urlWords('https://github.com/x/react-hooks_guide/issues/12345?tab=readme&id=9f86d081884c7d659a2feaa0c55ad015'),
    ).toEqual(['react', 'hooks', 'guide', 'issues', 'tab', 'readme', 'id']);
    expect(urlWords('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual(['watch']);
    expect(urlWords('https://a.com/blog/2024/05/index.html')).toEqual(['blog']);
    expect(urlWords('https://a.com/a1b2c3d4-0000-4bbb-8ccc-1234567890ab/page')).toEqual(['page']);
    expect(urlWords('https://www.google.com/search?q=side+events+berlin')).toEqual(['search', 'side', 'events', 'berlin']);
  });

  it('decodes percent-encoded non-ASCII words', () => {
    expect(urlWords('https://sr.wikipedia.org/wiki/%D0%91%D0%B5%D0%BE%D0%B3%D1%80%D0%B0%D0%B4')).toEqual(['wiki', 'београд']);
    expect(urlWords('not a url')).toEqual([]);
  });
});

describe('titleChunk', () => {
  it('is title — domain + path words', () => {
    expect(titleChunk('React  hooks\nguide', 'github.com', 'https://github.com/x/react-hooks/issues/12')).toBe(
      'React hooks guide — github.com react hooks issues',
    );
  });

  it('falls back to domain + words without a title', () => {
    expect(titleChunk('', 'example.com', 'https://example.com/')).toBe('example.com');
  });
});

describe('textChunks', () => {
  const sentence = (i: number) => `Sentence number ${i} talks about something moderately interesting here.`;

  it('keeps short text as one passage, whitespace collapsed', () => {
    expect(textChunks('Hello   world.\n\nSecond  paragraph.')).toEqual(['Hello world. Second paragraph.']);
    expect(textChunks('   \n  ')).toEqual([]);
  });

  it('packs paragraphs and splits long ones on sentence boundaries, about CHUNK_CHARS each', () => {
    const paras = Array.from({ length: 8 }, (_, p) => Array.from({ length: 6 }, (_, i) => sentence(p * 6 + i)).join(' '));
    const chunks = textChunks(paras.join('\n\n'));
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS * 1.25);
      expect(c).toMatch(/^Sentence number \d+/); // starts at a sentence boundary
      expect(c).toMatch(/here\.$/); // ends at one
    }
  });

  it('stops after MAX_TEXT_CHUNKS passages from the start of the page', () => {
    const text = Array.from({ length: 500 }, (_, i) => sentence(i)).join('\n');
    const chunks = textChunks(text);
    expect(chunks).toHaveLength(MAX_TEXT_CHUNKS);
    expect(chunks[0]).toMatch(/^Sentence number 0 /);
  });

  it('hard-splits text without sentence boundaries at word boundaries', () => {
    const chunks = textChunks('word '.repeat(400));
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c).toMatch(/^word( word)*$/);
  });

  it('folds a short tail into the previous passage', () => {
    const chunks = textChunks('a'.repeat(700) + '\n' + 'b'.repeat(150) + '\n' + 'c'.repeat(50));
    expect(chunks).toEqual(['a'.repeat(700), 'b'.repeat(150) + ' ' + 'c'.repeat(50)]);
  });
});
