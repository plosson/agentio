export interface JevCredentials {
  /** From console.typesafe.ai → Settings → Keys; sent as a Bearer token. */
  apiKey: string;
  /** Default model; `jev-latest` when absent. */
  model?: string;
}

/** What Jev evaluates: text, or a JSON object or array. */
export type JevState = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevNoulAnswer { type: 'noul'; noul: number }
export interface JevChoiceAnswer { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage { input_tokens: number; output_tokens: number }

/** One question's answer, with the model that gave it. */
export interface JevResult<A extends JevAnswer> {
  model: string;
  answer: A;
  usage: JevUsage | null;
}
