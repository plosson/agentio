declare module 'qrcode-terminal' {
  interface Options {
    small?: boolean;
  }

  export function generate(text: string, options?: Options, callback?: (qrcode: string) => void): void;
  export function setErrorLevel(level: 'L' | 'M' | 'Q' | 'H'): void;
}
