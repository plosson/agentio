import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { htmlToCanvasMarkdown } from '../../../src/plugins/slack/canvas-markdown';

const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures', 'canvas.html'), 'utf-8');
const wrap = (inner: string) => `<div class="quip-canvas-content">${inner}</div>`;
const list = (style: number, items: string) => `<div data-section-style='${style}'><ul>${items}</ul></div>`;
const li = (text: string, cls = '') => `<li${cls ? ` class='${cls}'` : ''}><span>${text}</span><br/></li>`;

describe('a real canvas', () => {
  const { markdown, unconverted } = htmlToCanvasMarkdown(FIXTURE);

  test('headings, checklist, numbered list, formatting, quote, link and mentions', () => {
    for (const line of [
      '# This a test canvas',
      '- [x] todo 1',
      '- [ ] Todo 2',
      '## qsd',
      '### qsd',
      '1. list1',
      '2. list2',
      'this is ![](#C0GENERAL) channel',
      '*this* is **formatting** ~~etc~~ ..',
      '> this is a blockquote',
      'This is a [link](http://google.com)',
      '![](@U0ALICE01)',
      ':raised_hands: emojis ..',
    ]) {
      expect(markdown).toContain(line);
    }
  });

  test('a list nested three levels keeps its indentation', () => {
    expect(markdown).toContain('- this\n  - this\n    - this\n    - this\n  - qdqsd');
  });

  test('a code block is fenced, one line per <br>', () => {
    expect(markdown).toContain('```\nCode block\nsdzeaze aze\n```');
  });

  test('a table gets a header row made from its first row', () => {
    expect(markdown).toContain('| azeaze | aze |\n| --- | --- |\n| ze | azea |\n| aze | aze |');
  });

  test('layouts keep their text; files become links; what cannot come back is listed once each', () => {
    expect(markdown).toContain('A layout');
    expect(markdown).toContain('[F0PDF00001](https://example.slack.com/files/U0ALICE01/F0PDF00001/report.pdf)');
    expect(markdown).not.toContain('_SLACK_FILE_ALT_PLACEHOLDER_');
    expect([...unconverted].sort()).toEqual(['embedded file F0IMAGE001', 'embedded file F0PDF00001', 'layout columns', 'mention alone on its line (shown as a profile card)', 'table header row', 'underline']);
  });

  test('no HTML and no ids of the HTML structure leak into the Markdown', () => {
    expect(markdown).not.toMatch(/<\/?[a-z]+[ >]/);
    expect(markdown).not.toContain('temp:C:');
  });

  test('zero-width spaces left by embedded files leave no invisible paragraph', () => {
    expect(markdown).not.toContain('\u200b');
    expect(markdown).not.toMatch(/\n{3,}/);
  });

  test('converting twice gives the same result', () => {
    expect(htmlToCanvasMarkdown(FIXTURE)).toEqual({ markdown, unconverted });
  });
});

describe('edge cases', () => {
  test('an empty canvas is empty Markdown with nothing unconverted', () => {
    expect(htmlToCanvasMarkdown(wrap(''))).toEqual({ markdown: '', unconverted: [] });
    expect(htmlToCanvasMarkdown(wrap('<p class="line"></p>'))).toEqual({ markdown: '', unconverted: [] });
  });

  test('a page that is not a canvas is refused, even when it mentions the canvas class elsewhere', () => {
    for (const page of ['', '<html><body><h1>Sign in to Slack</h1></body></html>', '<script>var c = "quip-canvas-content";</script><h1>Sign in</h1>']) {
      expect(() => htmlToCanvasMarkdown(page)).toThrow('not a canvas');
    }
  });

  test('only the canvas element is converted, not the page around it', () => {
    expect(htmlToCanvasMarkdown(`<header>Slack</header>${wrap('<p class="line">body</p>')}<footer>x</footer>`).markdown).toBe('body');
  });

  test('a zero-width space the author typed inside text is kept', () => {
    expect(htmlToCanvasMarkdown(wrap('<p class="line">a\u200bb</p>')).markdown).toBe('a\u200bb');
  });

  test('Markdown characters in text are escaped, so writing it back adds no formatting', () => {
    const { markdown } = htmlToCanvasMarkdown(wrap('<p class="line">2 * 3 is _six_</p><p class="line"># not a heading</p>'));
    expect(markdown).toContain('2 \\* 3 is \\_six\\_');
    expect(markdown).toContain('\\# not a heading');
  });

  test('an unknown element keeps its text and is listed', () => {
    const { markdown, unconverted } = htmlToCanvasMarkdown(wrap('<p class="line">a <blink>b</blink> c</p>'));
    expect(markdown).toBe('a b c');
    expect(unconverted).toEqual(['<blink> element']);
  });

  test('a mention of an unknown user stays a mention; a control with other text keeps the text and is listed', () => {
    expect(htmlToCanvasMarkdown(wrap('<p class="line"><control><a>@U0NOBODY1</a></control></p>')).markdown).toBe('![](@U0NOBODY1)');
    const other = htmlToCanvasMarkdown(wrap('<p class="line"><control><a>hello</a></control></p>'));
    expect(other.markdown).toBe('hello');
    expect(other.unconverted).toEqual(['special element']);
  });

  test('blank lines inside a code block are kept', () => {
    expect(htmlToCanvasMarkdown(wrap('<p class="prettyprint line">a<br><br><br>b</p>')).markdown).toBe('```\na\n\n\nb\n```');
  });

  test('a user mention alone on its line is flagged, one inside a sentence is not', () => {
    expect(htmlToCanvasMarkdown(wrap('<p class="line"><control><a>@U0ALICE01</a></control></p>')).unconverted)
      .toEqual(['mention alone on its line (shown as a profile card)']);
    expect(htmlToCanvasMarkdown(wrap('<p class="line">ask <control><a>@U0ALICE01</a></control> first</p>')).unconverted).toEqual([]);
    expect(htmlToCanvasMarkdown(wrap('<p class="line"><control><a>#C0GENERAL</a></control></p>')).unconverted).toEqual([]);
  });

  test('a link without href keeps its text', () => {
    expect(htmlToCanvasMarkdown(wrap('<p class="line"><lnk>plain</lnk></p>')).markdown).toBe('plain');
  });

  test('checked is found among other classes; numbered lists nest by three spaces', () => {
    expect(htmlToCanvasMarkdown(wrap(list(7, li('done', 'foo checked') + li('open', 'checkedness')))).markdown)
      .toBe('- [x] done\n- [ ] open');
    expect(htmlToCanvasMarkdown(wrap(list(6, `${li('one')}<ul>${li('sub')}</ul>${li('two')}`))).markdown)
      .toBe('1. one\n   1. sub\n2. two');
  });

  test('a table with a pipe in a cell and ragged rows stays a valid table', () => {
    const { markdown, unconverted } = htmlToCanvasMarkdown(wrap('<table><tr><td>a|b</td><td>c</td></tr><tr><td>d</td></tr></table>'));
    expect(markdown).toBe('| a\\|b | c |\n| --- | --- |\n| d |  |');
    expect(unconverted).toEqual(['table header row']);
  });

  test('a list style it does not know is a bulleted list, listed as unconverted', () => {
    const { markdown, unconverted } = htmlToCanvasMarkdown(wrap(list(9, li('x'))));
    expect(markdown).toBe('- x');
    expect(unconverted).toEqual(['list style 9']);
  });
});

describe('review fixes', () => {
  test('code keeps its indentation, inner spaces and first-line indent', () => {
    const html = wrap('<p class="prettyprint line">  top:<br>    nested:  x<br>        deep</p>');
    expect(htmlToCanvasMarkdown(html).markdown).toBe('```\n  top:\n    nested:  x\n        deep\n```');
  });

  test('a nested list at the very start keeps its indent', () => {
    expect(htmlToCanvasMarkdown(wrap(`<div data-section-style='5'><ul><ul>${li('orphan')}</ul></ul></div>`)).markdown).toBe('  - orphan');
  });
});
