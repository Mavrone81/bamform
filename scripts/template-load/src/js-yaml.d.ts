/**
 * Minimal ambient typing for js-yaml 4.x (already an api devDependency,
 * hoisted to the root node_modules; no @types package is installed).
 * Only the two functions this tooling uses.
 */
declare module 'js-yaml' {
  export interface DumpOptions {
    lineWidth?: number;
    noRefs?: boolean;
    sortKeys?: boolean;
    quotingType?: '"' | "'";
    forceQuotes?: boolean;
  }
  export function dump(obj: unknown, opts?: DumpOptions): string;
  export function load(text: string): unknown;
}
