// @mixmark-io/domino declares its types under the module name "domino"; this maps the one function used.
declare module '@mixmark-io/domino' {
  export function createDocument(html?: string, force?: boolean): Document;
}
