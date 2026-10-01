// Bun imports these as text (`with { type: 'text' }`); see assets.ts.
declare module '*.css' { const text: string; export default text; }
declare module '*.js' { const text: string; export default text; }
