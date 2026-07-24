/**
 * Structural path comparison shared by the contract tests: a path segment
 * that is a parameter (Nest `:id` or OpenAPI `{id}`) matches ANY parameter
 * segment in the same position, regardless of the parameter's name — Nest's
 * `:id` and openapi.yaml's `{id}` describe the same route even though the
 * literal token differs.
 */

const NEST_PARAM = /^:/;
const OPENAPI_PARAM = /^\{.*\}$/;

function isParamSegment(segment: string): boolean {
  return NEST_PARAM.test(segment) || OPENAPI_PARAM.test(segment);
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

export function pathsMatch(a: string, b: string): boolean {
  const segA = segments(a);
  const segB = segments(b);
  if (segA.length !== segB.length) return false;
  return segA.every((seg, i) => {
    const other = segB[i];
    if (isParamSegment(seg) && isParamSegment(other)) return true;
    return seg === other;
  });
}

export function methodPathKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
