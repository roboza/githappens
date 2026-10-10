/**
 * Generates `services/cloud/openapi.json` (OpenAPI 3.1) from the REST contract
 * `packages/cloud-api/src/types.ts`:
 *   - components.schemas: every exported interface / type alias, converted with the TypeScript
 *     type checker (so `extends`, `Omit`, `Partial`, unions and literal types are resolved);
 *   - paths: the route comment lines (`// METHOD /path  Body → Response`) of the contract.
 *
 *   node --disable-warning=ExperimentalWarning scripts/gen-openapi.ts [--check]
 *
 * `--check` exits 1 when the committed file is out of date (CI). The test suite runs the same check.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const CONTRACT_FILE = fileURLToPath(
  new URL('../../../packages/cloud-api/src/types.ts', import.meta.url),
);
export const OUTPUT_FILE = fileURLToPath(new URL('../openapi.json', import.meta.url));

type Schema = Record<string, unknown>;
type Methods = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Browser-only or token-in-URL routes that are deliberately not part of the JSON API description. */
export const UNDOCUMENTED_ROUTES = [
  'GET /oauth/callback/:idp',
  'POST /oauth/dev',
  'POST /oauth/email',
  'GET /oauth/email/callback',
  'GET /invite/:token',
  'PUT /v1/blobs/:token',
  'GET /v1/blobs/:token',
];

// ---- schemas ---------------------------------------------------------------------------------

function buildSchemas(program: ts.Program, file: ts.SourceFile): Record<string, Schema> {
  const checker = program.getTypeChecker();
  const named = new Map<ts.Symbol, string>();
  const decls: Array<{ name: string; node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration }> = [];
  for (const st of file.statements) {
    if (
      (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      !st.typeParameters?.length
    ) {
      const sym = checker.getSymbolAtLocation(st.name);
      if (sym) named.set(sym, st.name.text);
      decls.push({ name: st.name.text, node: st });
    }
  }

  const docOf = (sym: ts.Symbol | undefined): string | undefined => {
    if (!sym) return undefined;
    const text = ts.displayPartsToString(sym.getDocumentationComment(checker)).trim();
    return text || undefined;
  };

  const refFor = (t: ts.Type, self: string | undefined): string | undefined => {
    const sym = t.aliasSymbol ?? t.getSymbol();
    if (!sym) return undefined;
    const name = named.get(sym);
    return name && name !== self ? name : undefined;
  };

  const convert = (t: ts.Type, self?: string, depth = 0): Schema => {
    if (depth > 12) return {};
    const ref = refFor(t, self);
    if (ref) return { $ref: `#/components/schemas/${ref}` };
    const f = t.flags;
    if (f & ts.TypeFlags.String) return { type: 'string' };
    if (f & (ts.TypeFlags.Number | ts.TypeFlags.BigInt)) return { type: 'number' };
    if (f & ts.TypeFlags.Boolean) return { type: 'boolean' };
    if (f & ts.TypeFlags.Null) return { type: 'null' };
    if (f & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return {};
    if (t.isStringLiteral()) return { type: 'string', const: t.value };
    if (t.isNumberLiteral()) return { type: 'number', const: t.value };
    if (f & ts.TypeFlags.BooleanLiteral) {
      return { type: 'boolean', const: checker.typeToString(t) === 'true' };
    }
    if (t.isUnion()) {
      const parts = t.types.filter((x) => !(x.flags & ts.TypeFlags.Undefined));
      // boolean = true | false
      const bools = parts.filter((x) => x.flags & ts.TypeFlags.BooleanLiteral);
      const rest = parts.filter((x) => !(x.flags & ts.TypeFlags.BooleanLiteral));
      const items: Schema[] = rest.map((x) => convert(x, self, depth + 1));
      if (bools.length === 2) items.push({ type: 'boolean' });
      else items.push(...bools.map((x) => convert(x, self, depth + 1)));
      if (items.every((s) => s.type === 'string' && 'const' in s)) {
        return { type: 'string', enum: items.map((s) => s.const) };
      }
      return items.length === 1 ? items[0]! : { anyOf: items };
    }
    if (t.isIntersection()) return { allOf: t.types.map((x) => convert(x, self, depth + 1)) };
    if (checker.isArrayType(t) || checker.isTupleType(t)) {
      const args = checker.getTypeArguments(t as ts.TypeReference);
      if (checker.isTupleType(t)) {
        return {
          type: 'array',
          prefixItems: args.map((x) => convert(x, self, depth + 1)),
          minItems: args.length,
          maxItems: args.length,
        };
      }
      return { type: 'array', items: args[0] ? convert(args[0], self, depth + 1) : {} };
    }
    if (f & ts.TypeFlags.Object) {
      const out: Schema = { type: 'object' };
      const props: Record<string, Schema> = {};
      const required: string[] = [];
      for (const p of checker.getPropertiesOfType(t)) {
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const pt = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbol(p);
        const s = convert(pt, self, depth + 1);
        const doc = docOf(p);
        props[p.name] = doc && !('$ref' in s) ? { ...s, description: doc } : s;
        if (!(p.flags & ts.SymbolFlags.Optional)) required.push(p.name);
      }
      if (Object.keys(props).length) out.properties = props;
      if (required.length) out.required = required;
      const index = checker.getIndexInfosOfType(t)[0];
      if (index) out.additionalProperties = convert(index.type, self, depth + 1);
      return out;
    }
    return {};
  };

  const schemas: Record<string, Schema> = {};
  for (const { name, node } of decls) {
    const t = checker.getTypeAtLocation(node.name);
    const s = convert(t, name);
    const doc = docOf(checker.getSymbolAtLocation(node.name));
    schemas[name] = doc ? { ...s, description: doc } : s;
  }
  return schemas;
}

// ---- routes ----------------------------------------------------------------------------------

interface RouteComment {
  method: Methods;
  path: string;
  query: string;
  text: string;
}

const ROUTE_RE = /^\/\/\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]*)(\?\S*)?\s*(.*)$/;

export function parseRouteComments(source: string): RouteComment[] {
  const out: RouteComment[] = [];
  let current: RouteComment | null = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const m = ROUTE_RE.exec(line);
    if (m) {
      current = { method: m[1]!.toLowerCase() as Methods, path: m[2]!, query: m[3] ?? '', text: m[4] ?? '' };
      out.push(current);
      continue;
    }
    const cont = /^\/\/\s{3,}(\S.*)$/.exec(line);
    if (current && cont) current.text += ` ${cont[1]}`;
    else current = null;
  }
  return out;
}

const IDENT_RE = /\b([A-Z][A-Za-z]+)(\[\])?\b/g;

function typeExpr(expr: string, known: Set<string>): Schema | undefined {
  const e = expr.trim().replace(/^`|`$/g, '');
  const page = /^Page<([A-Za-z]+)>/.exec(e);
  if (page && known.has(page[1]!)) {
    return {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: `#/components/schemas/${page[1]}` } },
        nextCursor: { type: 'string' },
      },
      required: ['items'],
    };
  }
  const inter = /^([A-Z][A-Za-z]+)\s*&\s*\{\s*([^}]*)\}/.exec(e);
  if (inter && known.has(inter[1]!)) {
    const extra = Object.fromEntries(
      inter[2]!
        .split(/[,;]/)
        .map((s) => s.trim().replace(/[?:].*$/, ''))
        .filter(Boolean)
        .map((k) => [k, {}]),
    );
    return { allOf: [{ $ref: `#/components/schemas/${inter[1]}` }, { type: 'object', properties: extra }] };
  }
  const m = /^([A-Z][A-Za-z]+)(\[\])?/.exec(e);
  if (m && known.has(m[1]!)) {
    const ref = { $ref: `#/components/schemas/${m[1]}` };
    return m[2] ? { type: 'array', items: ref } : ref;
  }
  const obj = /^\{\s*([^}]*)\}/.exec(e);
  if (obj) {
    const props: Record<string, Schema> = {};
    const required: string[] = [];
    for (const part of obj[1]!.split(',')) {
      const k = /^\s*([a-zA-Z_]+)(\?)?/.exec(part);
      if (!k) continue;
      const rest = part.slice(part.indexOf(k[1]!) + k[1]!.length).replace(/^\?/, '');
      const typed = /^\s*:\s*([A-Za-z]+)(\[\])?/.exec(rest);
      let s: Schema = {};
      if (typed) {
        const tn = typed[1]!;
        const base: Schema =
          tn === 'string' || tn === 'IsoTime'
            ? { type: 'string' }
            : tn === 'number'
              ? { type: 'number' }
              : tn === 'boolean'
                ? { type: 'boolean' }
                : known.has(tn)
                  ? { $ref: `#/components/schemas/${tn}` }
                  : {};
        s = typed[2] ? { type: 'array', items: base } : base;
      } else if (known.has(k[1]!.charAt(0).toUpperCase() + k[1]!.slice(1))) {
        s = { $ref: `#/components/schemas/${k[1]!.charAt(0).toUpperCase()}${k[1]!.slice(1)}` };
      }
      props[k[1]!] = s;
      if (!k[2]) required.push(k[1]!);
    }
    return { type: 'object', properties: props, ...(required.length ? { required } : {}) };
  }
  return undefined;
}

function buildPaths(routes: RouteComment[], known: Set<string>): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const oaPath = r.path.replace(/:(\w+)/g, '{$1}');
    const params: Schema[] = [...r.path.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    for (const m of r.query.matchAll(/[?&[]([a-zA-Z_]+)/g)) {
      if (!params.some((p) => p.name === m[1]))
        params.push({ name: m[1], in: 'query', required: false, schema: { type: 'string' } });
    }
    if (/If-Match/.test(r.text)) {
      params.push({ name: 'If-Match', in: 'header', required: false, schema: { type: 'string' } });
    }
    const [lhs, ...rhsParts] = r.text.split('→');
    const rhs = rhsParts.join('→').trim();
    const op: Record<string, unknown> = {
      operationId: `${r.method}${oaPath
        .split('/')
        .filter(Boolean)
        .map((s) => s.replace(/[{}.-]/g, '').replace(/^./, (c) => c.toUpperCase()))
        .join('')}`,
      summary: r.text.replace(/\s+/g, ' ').trim().slice(0, 300) || `${r.method.toUpperCase()} ${r.path}`,
    };
    if (params.length) op.parameters = params;
    if (/PUBLIC/.test(r.text)) op.security = [];
    else if (/Bearer OPTIONAL/i.test(r.text)) op.security = [{}, { bearer: [] }];
    if (r.method === 'post' || r.method === 'put' || r.method === 'patch') {
      const body = lhs!
        .replace(/If-Match(:\s*<version>)?(\s*\([^)]*\))?/g, '')
        .replace(/PUBLIC\.?/g, '')
        .trim();
      let schema = typeExpr(body, known);
      if (!schema) {
        for (const m of body.matchAll(IDENT_RE)) {
          if (known.has(m[1]!)) {
            schema = typeExpr(m[0]!, known);
            break;
          }
        }
      }
      if (schema) op.requestBody = { required: true, content: { 'application/json': { schema } } };
    }
    const responses: Record<string, unknown> = {};
    const status = /^(\d{3})\b\s*(.*)$/.exec(rhs);
    const code = status ? status[1]! : r.method === 'post' && /\b201\b/.test(r.text) ? '201' : '200';
    const resExpr = (status ? status[2]! : rhs).split('|')[0]!.trim();
    if (code === '204') responses['204'] = { description: 'No content' };
    else {
      const schema = resExpr ? typeExpr(resExpr, known) : undefined;
      const html = /HTML|Browser page|viewer page/i.test(r.text);
      responses[code] = html
        ? { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } }
        : {
            description: 'Success',
            ...(schema ? { content: { 'application/json': { schema } } } : {}),
          };
    }
    responses.default = {
      description: 'Error',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
    };
    op.responses = responses;
    paths[oaPath] ??= {};
    if (!paths[oaPath][r.method]) paths[oaPath][r.method] = op;
  }
  return Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
}

// ---- document --------------------------------------------------------------------------------

export function generateOpenApi(contractFile = CONTRACT_FILE): Record<string, unknown> {
  const source = readFileSync(contractFile, 'utf8');
  const program = ts.createProgram([contractFile], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    types: [],
  });
  const file = program.getSourceFile(contractFile);
  if (!file) throw new Error(`cannot read ${contractFile}`);
  const schemas = buildSchemas(program, file);
  const known = new Set(Object.keys(schemas));
  const header = /\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? '';
  const description = header
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
  return {
    openapi: '3.1.0',
    info: {
      title: 'GitHappens Cloud API',
      version: (
        JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
          version: string;
        }
      ).version,
      description,
      license: { name: 'Proprietary' },
    },
    servers: [{ url: 'http://localhost:8787' }],
    security: [{ bearer: [] }],
    paths: buildPaths(parseRouteComments(source), known),
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

function main(): void {
  const doc = generateOpenApi();
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    let current: unknown = null;
    try {
      current = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'));
    } catch {
      /* missing */
    }
    if (JSON.stringify(current) !== JSON.stringify(doc)) {
      process.stderr.write('openapi.json is out of date: run `pnpm --filter @githappens/cloud openapi`\n');
      process.exit(1);
    }
    return;
  }
  writeFileSync(OUTPUT_FILE, text, 'utf8');
  process.stdout.write(
    `wrote ${OUTPUT_FILE} (${Object.keys(doc.paths as object).length} paths, ${
      Object.keys((doc.components as { schemas: object }).schemas).length
    } schemas)\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
