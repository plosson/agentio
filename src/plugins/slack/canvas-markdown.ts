import { createDocument } from '@mixmark-io/domino';
import TurndownService from 'turndown';
import { CliError } from '../../utils/errors';

export interface CanvasMarkdown {
  markdown: string;
  /** Parts of the canvas that Markdown cannot carry back, described once each. */
  unconverted: string[];
}

type ListStyle = 'bullet' | 'numbered' | 'checklist';
/** Canvas lists, by the data-section-style of the div around them. */
const LIST_STYLES: Record<string, ListStyle> = { '5': 'bullet', '6': 'numbered', '7': 'checklist' };
/**
 * Elements that only wrap content, so nothing is lost when they are dropped. Table parts are
 * seen before the table rule runs; an <a> without href (inside a mention) is only its text.
 */
const TRANSPARENT = new Set(['DIV', 'SPAN', 'BODY', 'HTML', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'TD', 'TH', 'A']);
const FILE_PLACEHOLDER = /^_SLACK_FILE_ALT_PLACEHOLDER_(F[A-Z0-9]+)$/;
const EMBEDDED_FILE = /File ID: sf:(F[A-Z0-9]+), File URL: (\S+)/;
const MENTION = /^([@#])([UWCG][A-Z0-9]+)$/;
/** Text that is only Slack's zero-width padding around embedded files. */
const PADDING = /^[\u200b\s]*\u200b[\u200b\s]*$/;
const trimNewlines = (text: string) => text.replace(/^\n+|\n+$/g, '');

type Element = HTMLElement;

const hasClass = (node: Element, name: string) => (node.getAttribute('class') ?? '').split(/\s+/).includes(name);
const children = (node: Element) => Array.from(node.childNodes) as Element[];
const isList = (node: Element) => node.nodeName === 'UL' || node.nodeName === 'OL';

/**
 * The canvas element of a page Slack sent, made ready for turndown: code paragraphs become
 * <pre>, whose whitespace turndown keeps, and padding-only text goes, so its paragraphs are blank.
 */
function canvasRoot(html: string, title: string | undefined): Element {
  const doc = createDocument(html);
  const root = doc.querySelector('.quip-canvas-content') as Element | null;
  if (!root) throw new CliError('API_ERROR', 'Slack sent a page that is not a canvas');
  // Slack repeats the title as the first heading; kept, a set would add it to the content.
  const first = root.firstElementChild;
  if (title?.trim() && first?.nodeName === 'H1' && first.textContent?.trim() === title.trim()) first.remove();
  for (const code of Array.from(root.querySelectorAll('p.prettyprint'))) {
    const pre = doc.createElement('pre');
    pre.setAttribute('class', code.getAttribute('class') ?? '');
    while (code.firstChild) pre.appendChild(code.firstChild);
    code.replaceWith(pre);
  }
  const dropPadding = (node: Element) => {
    for (const child of children(node)) {
      if (child.nodeType === 3 && PADDING.test(child.nodeValue ?? '')) child.remove();
      else dropPadding(child);
    }
  };
  dropPadding(root);
  return root;
}

/** Text with <br> as a newline, for code blocks. */
function codeText(node: Element): string {
  let out = '';
  for (const child of children(node)) {
    if (child.nodeName === 'BR') out += '\n';
    else if (child.nodeType === 3) out += child.nodeValue ?? '';
    else out += codeText(child);
  }
  return out;
}

/**
 * Slack's canvas HTML as the Markdown canvases.create and canvases.edit accept; API_ERROR when it
 * is not a canvas. With the canvas title, the heading that repeats it is left out.
 */
export function htmlToCanvasMarkdown(html: string, title?: string): CanvasMarkdown {
  const unconverted = new Set<string>();
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---',
    defaultReplacement: (content, node) => {
      const name = node.nodeName;
      if (name === 'U') unconverted.add('underline');
      else if (!TRANSPARENT.has(name)) unconverted.add(`<${name.toLowerCase()}> element`);
      return (node as unknown as { isBlock: boolean }).isBlock ? `\n\n${content}\n\n` : content;
    },
  });
  const inline = (node: Element) => service.turndown(node).replace(/\n+/g, ' ').trim();

  function renderList(list: Element, style: ListStyle, depth: number, lines: string[]): void {
    const indent = ' '.repeat(depth * (style === 'numbered' ? 3 : 2));
    let n = 0;
    for (const child of children(list)) {
      if (isList(child)) {
        renderList(child, style, depth + 1, lines);
        continue;
      }
      if (child.nodeName !== 'LI') continue;
      n += 1;
      const marker = style === 'numbered' ? `${n}.` : style === 'checklist' ? (hasClass(child, 'checked') ? '- [x]' : '- [ ]') : '-';
      lines.push(`${indent}${marker} ${inline(child)}`);
    }
  }

  service.addRule('strikethrough', {
    filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
    replacement: (content) => `~~${content}~~`,
  });

  service.addRule('canvasLink', {
    filter: (node) => node.nodeName === 'LNK',
    replacement: (content, node) => {
      const href = (node as Element).getAttribute('href');
      return href ? `[${content}](${href})` : content;
    },
  });

  service.addRule('control', {
    filter: (node) => node.nodeName === 'CONTROL',
    replacement: (_content, node) => {
      const element = node as Element;
      const emoji = element.querySelector('img')?.getAttribute('alt');
      if (emoji) return `:${emoji}:`;
      const text = (element.textContent ?? '').trim();
      const mention = MENTION.exec(text);
      if (mention) {
        // Alone on its line, Slack shows a written-back user mention as a profile card, not inline.
        if (mention[1] === '@' && (element.parentNode?.textContent ?? '').trim() === text) {
          unconverted.add('mention alone on its line (shown as a profile card)');
        }
        return `![](${mention[1]}${mention[2]})`;
      }
      unconverted.add('special element');
      return text;
    },
  });

  service.addRule('canvasList', {
    filter: (node) => node.nodeName === 'DIV' && node.hasAttribute('data-section-style') && children(node).some(isList),
    replacement: (_content, node) => {
      const styleKey = (node as Element).getAttribute('data-section-style') ?? '';
      const style = LIST_STYLES[styleKey];
      if (!style) unconverted.add(`list style ${styleKey}`);
      const lines: string[] = [];
      for (const list of children(node as Element)) {
        if (isList(list)) renderList(list, style ?? 'bullet', 0, lines);
      }
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });

  service.addRule('codeBlock', {
    filter: (node) => node.nodeName === 'PRE' && hasClass(node, 'prettyprint'),
    replacement: (_content, node) => {
      const code = trimNewlines(codeText(node as Element).split('\n').map((line) => line.trimEnd()).join('\n'));
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    },
  });

  service.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from((node as Element).querySelectorAll('tr')).map((tr) =>
        children(tr as Element).filter((c) => c.nodeName === 'TD' || c.nodeName === 'TH').map((cell) => inline(cell).replace(/\|/g, '\\|')));
      if (rows.length === 0) return '';
      // Canvas tables have no header row; a Markdown table always does, so after a set the first row is one.
      unconverted.add('table header row');
      const width = Math.max(...rows.map((r) => r.length));
      const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
      return `\n\n${[line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`;
    },
  });

  service.addRule('layout', {
    filter: (node) => node.nodeName === 'DIV' && hasClass(node, 'flexbox'),
    replacement: (content) => {
      unconverted.add('layout columns');
      return `\n\n${content}\n\n`;
    },
  });

  service.addRule('embeddedImage', {
    filter: (node) => node.nodeName === 'IMG' && FILE_PLACEHOLDER.test(node.getAttribute('alt') ?? ''),
    replacement: (_content, node) => {
      unconverted.add(`embedded file ${FILE_PLACEHOLDER.exec((node as Element).getAttribute('alt') ?? '')![1]}`);
      return '';
    },
  });

  service.addRule('embeddedFile', {
    filter: (node) => node.nodeName === 'P' && hasClass(node, 'embedded-file'),
    replacement: (_content, node) => {
      const file = EMBEDDED_FILE.exec((node as Element).textContent ?? '');
      if (!file) {
        unconverted.add('embedded file');
        return '';
      }
      unconverted.add(`embedded file ${file[1]}`);
      return `\n\n[${file[1]}](${file[2]})\n\n`;
    },
  });

  // Slack pads embedded files with zero-width spaces: paragraphs of nothing else go, and the rest are dropped.
  const markdown = trimNewlines(service.turndown(canvasRoot(html, title)));
  return { markdown, unconverted: [...unconverted] };
}
