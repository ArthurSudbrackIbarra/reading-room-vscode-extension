// Converting a long document in batches: where the batches end, and that the first blocks of a
// Markdown document can be rendered alone and again with the rest.
import { describe, expect, it } from 'vitest';
import { BATCHED_FROM, BATCH_GROWTH, BLOCK_WEIGHT, DIAGRAM_WEIGHT, FIRST_BATCH, IMAGE_WEIGHT, batchPlan, lineWeights } from '../../src/converter/batches';
import { plainCodeHtml, type CodeHighlighter } from '../../src/converter/highlight';
import { languagesBefore, parseMarkdown, renderParsed, topLevelBlocks } from '../../src/converter/markdown';

const plain: CodeHighlighter = { highlight: (code) => plainCodeHtml(code) };
const urls = { docPath: '/c:/notes/doc.md', workspaceRootPath: '/c:/notes' };
const blocksOf = (count: number, weight: number) => Array.from({ length: count }, () => weight);

describe('batchPlan', () => {
  it('converts a short document in one go', () => {
    expect(batchPlan([])).toEqual([]);
    expect(batchPlan(blocksOf(10, 500))).toEqual([]);
    // Just under the size from which batches are worth it.
    expect(batchPlan(blocksOf(BATCHED_FROM * 20 - 1, FIRST_BATCH / 20))).toEqual([]);
  });

  it('gives a long document a first batch of about FIRST_BATCH', () => {
    const weights = blocksOf(BATCHED_FROM * 20, FIRST_BATCH / 20);
    expect(batchPlan(weights)).toEqual([20]);
  });

  it('ends a batch with the block that fills it', () => {
    // Blocks of 3 000: the seventh takes the batch to 21 000.
    const plan = batchPlan(blocksOf(200, 3000));
    expect(plan[0]).toBe(7);
  });

  it('gives a very long document larger and larger batches, each from the top', () => {
    // 3 000 000 (about a thousand pages): a third batch would be more than a third of it.
    expect(batchPlan(blocksOf(6000, 500))).toEqual([FIRST_BATCH / 500, (FIRST_BATCH * BATCH_GROWTH) / 500]);
    // 4 000 000: three batches.
    expect(batchPlan(blocksOf(8000, 500))).toEqual([FIRST_BATCH / 500, (FIRST_BATCH * BATCH_GROWTH) / 500, (FIRST_BATCH * BATCH_GROWTH ** 2) / 500]);
  });

  it('makes no batch that is most of the document', () => {
    // One block is nearly everything: nothing can be shown ahead of it.
    expect(batchPlan([100, 400_000, 100])).toEqual([]);
    // The first batch is fine, the second would be more than half.
    const plan = batchPlan([...blocksOf(40, 500), 400_000, ...blocksOf(700, 500)]);
    expect(plan).toEqual([40]);
  });
});

describe('lineWeights', () => {
  it('counts a line of the page for every 95 characters of a line of text', () => {
    expect(lineWeights(['', 'short', 'x'.repeat(95), 'x'.repeat(96), 'x'.repeat(950)])).toEqual([45, 45, 45, 90, 450]);
  });
});

describe('topLevelBlocks', () => {
  const source = [
    '# Title',
    '',
    'A first paragraph with a [link](other.md) and an image ![alt](pic.png).',
    '',
    '- one',
    '- two',
    '  - nested',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
    '',
    '> a quote',
    '',
    'The last paragraph.',
  ].join('\n');

  it('ends a block after every top-level element, nested ones inside their parent', () => {
    const parsed = parseMarkdown(source, urls);
    const blocks = topLevelBlocks(parsed);
    // Heading, paragraph, list, table, code, diagram, quote, paragraph.
    expect(blocks).toHaveLength(8);
    expect(blocks[blocks.length - 1].end).toBe(parsed.tokens.length);
    for (const block of blocks) {
      const last = parsed.tokens[block.end - 1];
      expect(last.level).toBe(0);
      expect(last.nesting).toBeLessThanOrEqual(0);
    }
  });

  it('weighs text by its length, and pictures and diagrams by the room and time they take', () => {
    const blocks = topLevelBlocks(parseMarkdown(source, urls));
    expect(blocks[0].weight).toBe('Title'.length + BLOCK_WEIGHT);
    expect(blocks[1].weight).toBeGreaterThan(IMAGE_WEIGHT);
    expect(blocks[1].weight).toBeLessThan(IMAGE_WEIGHT + 200);
    expect(blocks[5].weight).toBe(DIAGRAM_WEIGHT + BLOCK_WEIGHT);
  });

  it('renders the first blocks as the start of the whole document', () => {
    const parsed = parseMarkdown(source, urls);
    const blocks = topLevelBlocks(parsed);
    const whole = renderParsed(parsed, plain);
    for (const block of blocks) expect(whole.startsWith(renderParsed(parsed, plain, block.end))).toBe(true);
  });

  it('gives each render its own list of diagrams', () => {
    const parsed = parseMarkdown(source, urls);
    const blocks = topLevelBlocks(parsed);
    renderParsed(parsed, plain, blocks[4].end);
    const before = parsed.env.mermaid;
    renderParsed(parsed, plain);
    expect(before).toEqual([]);
    expect(parsed.env.mermaid).toEqual(['graph TD; A-->B;\n']);
  });

  it('resolves addresses once, however often a block is rendered', () => {
    const html = '<img src="pic.png">\n\nText with ![alt](pic.png), a [link](other.md) and <img src="pic.png"> inline.';
    const once = renderParsed(parseMarkdown(html, urls), plain);
    const parsed = parseMarkdown(html, urls);
    renderParsed(parsed, plain, topLevelBlocks(parsed)[0].end);
    renderParsed(parsed, plain);
    expect(renderParsed(parsed, plain)).toBe(once);
    expect(once).toContain('pic.png');
  });

  it('tells which grammars a first part needs', () => {
    const parsed = parseMarkdown('```py\nx\n```\n\ntext\n\n```rust\ny\n```\n', urls);
    const blocks = topLevelBlocks(parsed);
    expect([...languagesBefore(parsed, blocks[1].end)]).toEqual(['py']);
    expect([...languagesBefore(parsed, parsed.tokens.length)]).toEqual(['py', 'rust']);
  });
});
