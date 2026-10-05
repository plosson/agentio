import type { InputSpec, SetupContext } from '../../src/plugin-sdk';
import { checkAnswer } from '../../src/plugins/setup-inputs';
import { CliError } from '../../src/utils/errors';

/** A setup context for tests: answers by id, records what was asked and opened, never prompts. */
export function fakeSetupContext(answers: Record<string, string>, opened: string[] = []): SetupContext & { asked: InputSpec[] } {
  const asked: InputSpec[] = [];
  return {
    asked,
    async ask(spec) {
      asked.push(spec);
      if (!(spec.id in answers)) throw new Error(`unexpected question: ${spec.id}`);
      return checkAnswer(spec, answers[spec.id]);
    },
    async prompt(question) { throw new Error(`prompt must not be used: ${question}`); },
    async confirm(question) { throw new Error(`confirm must not be used: ${question}`); },
    log: () => {},
    openUrl(url) { opened.push(url); return true; },
    async oauth() { throw new Error('oauth must not be used'); },
    fail(code, message, suggestion): never { throw new CliError(code, message, suggestion); },
    fetch,
  };
}
