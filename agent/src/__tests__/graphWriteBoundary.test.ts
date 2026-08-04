/**
 * TRO-321 / FG-8 proof #1, structural half — "confirm (don't assume) that no
 * node in any of the three [graph] chains calls anything beyond the
 * additive read-only client interfaces already established" (the ticket's
 * own words).
 *
 * This is a real AST walk over `graph.ts`'s own source (via the TypeScript
 * compiler API, already a devDependency of this package — not a fragile
 * regex over formatting), not a claim about what the file "usually" does.
 * It checks four independent things, any ONE of which would be a hole a
 * graph node could write through:
 *   1. No identifier named `GateShipClient`/`GateShipClientLike` appears
 *      anywhere in the file — the write-capable client TRO-321 adds
 *      (`shipClient.ts`) is never even NAMED here, let alone held by a node.
 *   2. No call expression invokes `.request(` — the one write-capable method
 *      on `ResilientClient` (`resilientClient.ts`'s own docstring: "Non-
 *      idempotent request... no retry" — every read in this package uses
 *      `.get` instead). A node calling `.request(` directly would be a write
 *      with no `GateShipClient` in sight, so this check is independent of
 *      check #1, not redundant with it.
 *   3. No bare `fetch(` call — every outbound call in this whole package
 *      must go through `ResilientClient` (PR-B / TRO-315), never a raw
 *      fetch that bypasses its timeout/retry/breaker/self-throttle.
 *   4. `ProactiveDeps`/`OnDemandDeps`/`DeepDeps` — the three dependency
 *      shapes the graph's nodes actually receive — type their `shipClient`
 *      field as ONLY one of the three additive READ-ONLY interfaces
 *      (`ShipClientLike`/`OnDemandShipClientLike`/`DeepShipClientLike`).
 *      Even if checks 1-3 somehow missed something, a node can only call
 *      what its own injected `deps.shipClient` exposes — this is the type
 *      contract that makes checks 1-3 provably exhaustive rather than "we
 *      didn't happen to find one."
 *
 * `it('control: ...')` below proves this file's own checkers have teeth —
 * run against a deliberately poisoned snippet, each one fails, exactly as it
 * would if a future edit to graph.ts introduced the violation these checks
 * exist to catch.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GRAPH_PATH = join(__dirname, '../graph.ts');

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function findWriteCapableIdentifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  walk(source, (node) => {
    if (ts.isIdentifier(node) && (node.text === 'GateShipClient' || node.text === 'GateShipClientLike')) {
      found.push(node.text);
    }
  });
  return found;
}

function findRequestCalls(source: ts.SourceFile): string[] {
  const found: string[] = [];
  walk(source, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'request') {
      found.push(node.getText(source));
    }
  });
  return found;
}

function findBareFetchCalls(source: ts.SourceFile): string[] {
  const found: string[] = [];
  walk(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      found.push(node.getText(source));
    }
  });
  return found;
}

const DEPS_INTERFACES = ['ProactiveDeps', 'OnDemandDeps', 'DeepDeps'] as const;
const ALLOWED_SHIP_CLIENT_TYPES = new Set(['ShipClientLike', 'OnDemandShipClientLike', 'DeepShipClientLike']);

function findDepsShipClientTypes(source: ts.SourceFile): Record<string, string> {
  const found: Record<string, string> = {};
  walk(source, (node) => {
    if (ts.isInterfaceDeclaration(node) && (DEPS_INTERFACES as readonly string[]).includes(node.name.text)) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name.getText(source) === 'shipClient' && member.type) {
          found[node.name.text] = member.type.getText(source);
        }
      }
    }
  });
  return found;
}

function findNamedImportsFrom(source: ts.SourceFile, moduleSpecifier: string): string[] {
  const found: string[] = [];
  walk(source, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === moduleSpecifier) {
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          found.push(el.name.text);
        }
      }
    }
  });
  return found;
}

describe('graph.ts never holds a write-capable client (TRO-321 / FG-8 proof #1, structural half)', () => {
  const graphText = readFileSync(GRAPH_PATH, 'utf8');
  const graphSource = parse(GRAPH_PATH, graphText);

  it('never references GateShipClient / GateShipClientLike by name, anywhere in the file', () => {
    expect(findWriteCapableIdentifiers(graphSource)).toEqual([]);
  });

  it('never calls .request( — the one write-capable method on ResilientClient', () => {
    expect(findRequestCalls(graphSource)).toEqual([]);
  });

  it('never calls a bare fetch( — every outbound call goes through ResilientClient (PR-B / TRO-315)', () => {
    expect(findBareFetchCalls(graphSource)).toEqual([]);
  });

  it('imports from shipClient.js never include GateShipClient / GateShipClientLike', () => {
    const imported = findNamedImportsFrom(graphSource, './shipClient.js');
    expect(imported.length).toBeGreaterThan(0); // sanity: the file DOES import from shipClient.js
    expect(imported).not.toContain('GateShipClient');
    expect(imported).not.toContain('GateShipClientLike');
  });

  it('ProactiveDeps / OnDemandDeps / DeepDeps.shipClient are typed ONLY as the additive read-only *Like interfaces', () => {
    const shipClientTypes = findDepsShipClientTypes(graphSource);

    expect(Object.keys(shipClientTypes).sort()).toEqual([...DEPS_INTERFACES].sort());
    for (const [iface, typeText] of Object.entries(shipClientTypes)) {
      expect(ALLOWED_SHIP_CLIENT_TYPES.has(typeText), `${iface}.shipClient is typed "${typeText}"`).toBe(true);
    }
  });

  describe('control — these checks have teeth', () => {
    it('findWriteCapableIdentifiers catches a poisoned import', () => {
      const poisoned = parse(
        'poisoned.ts',
        `import type { GateShipClientLike } from './shipClient.js';\nfunction f(x: GateShipClientLike) { return x; }`
      );
      expect(findWriteCapableIdentifiers(poisoned)).toEqual(['GateShipClientLike', 'GateShipClientLike']);
    });

    it('findRequestCalls catches a bare .request( call', () => {
      const poisoned = parse('poisoned.ts', `async function f(client: { request: (u: string) => Promise<unknown> }) { await client.request('x'); }`);
      expect(findRequestCalls(poisoned).length).toBeGreaterThan(0);
    });

    it('findBareFetchCalls catches a bare fetch( call', () => {
      const poisoned = parse('poisoned.ts', `async function f() { await fetch('https://ship.example.gov/api/issues/1'); }`);
      expect(findBareFetchCalls(poisoned).length).toBeGreaterThan(0);
    });

    it('findDepsShipClientTypes catches a Deps interface typed to the write-capable client', () => {
      const poisoned = parse(
        'poisoned.ts',
        `interface ProactiveDeps { shipClient: GateShipClientLike; }`
      );
      const found = findDepsShipClientTypes(poisoned);
      expect(found.ProactiveDeps).toBe('GateShipClientLike');
      expect(ALLOWED_SHIP_CLIENT_TYPES.has(found.ProactiveDeps as string)).toBe(false);
    });
  });
});
