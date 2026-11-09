import { describe, expect, it } from 'vitest';
import { plainTextToHtml } from '../../src/converter/text';

describe('plainTextToHtml', () => {
  it('keeps the text as written and escapes HTML', () => {
    expect(plainTextToHtml('a <b> & "c"\n\tindented')).toBe('<pre class="plain-text">a &lt;b&gt; &amp; &quot;c&quot;\n\tindented</pre>');
  });

  it('normalizes line endings, drops a BOM and the final newline', () => {
    expect(plainTextToHtml('﻿one\r\ntwo\rthree\n')).toBe('<pre class="plain-text">one\ntwo\nthree</pre>');
  });

  it('links explicit web and mail addresses only', () => {
    const html = plainTextToHtml('See https://example.com/a?b=1&c=2, mail me at mailto:me@example.com. Not readme.md or notes.txt or www.example.org');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>');
    expect(html).toContain('<a href="mailto:me@example.com">mailto:me@example.com</a>');
    expect(html).not.toContain('href="http://readme.md"');
    expect(html).not.toContain('notes.txt</a>');
  });

  it('does not let text break out of the pre element', () => {
    expect(plainTextToHtml('</pre><script>alert(1)</script>')).toBe('<pre class="plain-text">&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;</pre>');
  });
});
