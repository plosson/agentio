import { describe, expect, test } from 'bun:test';
import { formatSlackText } from '../../../src/plugins/slack/format';

const names = { users: new Map([['U0001', 'alice']]), channels: new Map([['C0ENG', 'eng']]) };
const f = (text: string) => formatSlackText(text, names);

describe('formatSlackText', () => {
  test('links: a label reads "label (url)", a bare or self-labelled link is the url alone', () => {
    expect(f('see <https://example.com/docs|the docs> now')).toBe('see the docs (https://example.com/docs) now');
    expect(f('<https://example.com/a>')).toBe('https://example.com/a');
    expect(f('<https://example.com/|example.com>')).toBe('https://example.com/');
    expect(f('<mailto:a@example.com|a@example.com>')).toBe('a@example.com');
  });

  test('mentions, channel links and broadcasts', () => {
    expect(f('hi <@U0001> and <@U0009|old>')).toBe('hi @alice and @U0009');
    expect(f('in <#C0ENG|eng> and <#C0ENG> and <#C0X>')).toBe('in #eng and #eng and #C0X');
    expect(f('<!here> <!channel> <!everyone>')).toBe('@here @channel @everyone');
    expect(f('<!subteam^S0123|@oncall> <!subteam^S0456>')).toBe('@oncall @S0456');
    expect(f('<!date^1700000000^{date}|Nov 14>')).toBe('Nov 14');
  });

  test('escaped characters are decoded after the markup, so they never become markup', () => {
    expect(f('a &lt;b&gt; &amp;lt; <https://x.dev?a=1&amp;b=2|q &amp; a>')).toBe('a <b> &lt; q & a (https://x.dev?a=1&b=2)');
  });
});
