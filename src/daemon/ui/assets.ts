// bun-types declares `*.html` as an HTMLBundle for Bun's HTML bundler, but with
// the `text` import attribute every one of these resolves to the file's
// contents, and `bun build --compile` embeds it. The casts reconcile the two.
import indexHtml from './index.html' with { type: 'text' };
import styles from './styles.css' with { type: 'text' };
// @ts-expect-error -- Bun imports this TypeScript file's source as text; it is transpiled below.
import modelSource from './model.ts' with { type: 'text' };
import icons from './app/icons.js' with { type: 'text' };
import core from './app/core.js' with { type: 'text' };
import unlock from './app/unlock.js' with { type: 'text' };
import overview from './app/overview.js' with { type: 'text' };
import profiles from './app/profiles.js' with { type: 'text' };
import machines from './app/machines.js' with { type: 'text' };
import authorize from './app/authorize.js' with { type: 'text' };
import access from './app/access.js' with { type: 'text' };
import settings from './app/settings.js' with { type: 'text' };
import main from './app/main.js' with { type: 'text' };

const text = (source: unknown): string => source as string;

/**
 * model.ts as the page runs it: types stripped by Bun's transpiler, and its
 * `export` keywords dropped, since the page's script is a classic script that
 * shares one scope with the screens.
 */
const model = new Bun.Transpiler({ loader: 'ts' })
  .transformSync(text(modelSource))
  .replace(/^export (?=(async )?function |const |let |class )/gm, '');

/** Order matters: the screens use the model, the icons and core; main boots last. */
const script = [model, icons, core, unlock, overview, profiles, machines, authorize, access, settings, main].map(text).join('\n');

/**
 * The admin page with its style and script inlined. Function replacers keep
 * `$` sequences in the sources from being read as replacement patterns.
 * `__CSP_NONCE__` and `__PLUGIN_METADATA__` stay for routes-ui.ts to fill per request.
 */
export const INDEX_HTML = text(indexHtml)
  .replace('/*__STYLES__*/', () => text(styles))
  .replace('//__SCRIPT__', () => script);
