import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const OPENAPI_PATH = join(__dirname, '..', '..', 'openapi.yaml');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

export interface OpenapiOperation {
  method: string; // upper-case
  path: string; // OpenAPI-style, e.g. /assets/{assetId}
  operationId: string | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenapiDocument = Record<string, any>;

let cachedDocument: OpenapiDocument | undefined;

/** Parses `api/openapi.yaml` once per test process. */
export function loadOpenapiDocument(): OpenapiDocument {
  if (!cachedDocument) {
    const raw = readFileSync(OPENAPI_PATH, 'utf8');
    cachedDocument = load(raw) as OpenapiDocument;
  }
  return cachedDocument;
}

/** Every `{method, path}` operation declared under `paths`. */
export function listOpenapiOperations(
  doc: OpenapiDocument = loadOpenapiDocument(),
): OpenapiOperation[] {
  const operations: OpenapiOperation[] = [];
  const paths = doc.paths as Record<string, Record<string, unknown>>;
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as { operationId?: string } | undefined;
      if (!operation) continue;
      operations.push({ method: method.toUpperCase(), path, operationId: operation.operationId });
    }
  }
  return operations;
}

/**
 * Resolves a `$ref` pointer (`#/components/schemas/Foo`) against the loaded
 * document. Only supports local document refs, which is all `openapi.yaml`
 * uses.
 */
export function resolveRef<T = unknown>(
  ref: string,
  doc: OpenapiDocument = loadOpenapiDocument(),
): T {
  const segments = ref.replace(/^#\//, '').split('/');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = doc;
  for (const segment of segments) {
    node = node?.[segment];
  }
  return node as T;
}

export function getSchema(
  name: string,
  doc: OpenapiDocument = loadOpenapiDocument(),
): Record<string, unknown> {
  const schema = doc.components?.schemas?.[name];
  if (!schema) {
    throw new Error(`openapi.yaml has no components.schemas.${name}`);
  }
  return schema as Record<string, unknown>;
}
