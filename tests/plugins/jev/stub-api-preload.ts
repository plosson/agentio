// Preloaded into a CLI subprocess (BUN_OPTIONS=--preload): api.typesafe.ai is answered here, so a test
// never leaves the machine. STUB_JEV_KEY is the only good key; STUB_JEV_NOUL is the probability of yes.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.typesafe.ai/')) throw new TypeError(`blocked: ${url}`);
  if (new Headers(init?.headers).get('authorization') !== `Bearer ${process.env.STUB_JEV_KEY}`) {
    return new Response(JSON.stringify({ error: 'invalid key' }), { status: 401 });
  }
  const body = JSON.parse(String(init?.body)) as { questions: { answer: { type: string; criteria?: unknown } } };
  const question = body.questions.answer;
  const answer = question.type === 'noul'
    ? { type: 'noul', noul: Number(process.env.STUB_JEV_NOUL ?? '0.9') }
    : question.type === 'choice'
      ? { type: 'choice', choice: Object.keys(question.criteria as object)[0], confidence: 0.91, probabilities: {} }
      : { type: 'score', score: 1.3, confidence: 0.54, probabilities: {} };
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { answer }, usage: { input_tokens: 3, output_tokens: 0 } }), { status: 200 });
}) as typeof fetch;
