import { writeJson } from '../../utils/output';
import type { JevAnswer, JevChoiceAnswer, JevNoulAnswer, JevResult, JevScoreAnswer } from './types';

const json = (result: JevResult<JevAnswer>) => writeJson({ ...result.answer, model: result.model, usage: result.usage });

/** `yes 0.97`: the decision, then the probability of yes. */
export function printYesNo(result: JevResult<JevNoulAnswer>, yes: boolean, asJson?: boolean): void {
  if (asJson) return json(result);
  console.log(`${yes ? 'yes' : 'no'} ${result.answer.noul.toFixed(2)}`);
}

/** `billing 0.91`: the chosen key, then the confidence. */
export function printChoice(result: JevResult<JevChoiceAnswer>, asJson?: boolean): void {
  if (asJson) return json(result);
  console.log(`${result.answer.choice} ${result.answer.confidence.toFixed(2)}`);
}

/** `1.3 (confidence 0.54)`. */
export function printScore(result: JevResult<JevScoreAnswer>, asJson?: boolean): void {
  if (asJson) return json(result);
  console.log(`${result.answer.score} (confidence ${result.answer.confidence.toFixed(2)})`);
}
