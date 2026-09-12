// bun-types declares `*.html` as an HTMLBundle for Bun's HTML bundler, but with
// the `text` import attribute the module resolves to the file's contents, and
// `bun build --compile` embeds it. The cast reconciles the two.
import indexHtml from './index.html' with { type: 'text' };

export const INDEX_HTML = indexHtml as unknown as string;
