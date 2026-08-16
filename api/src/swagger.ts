/**
 * Swagger/OpenAPI Setup
 *
 * This module configures Swagger UI and serves the OpenAPI specification.
 * Schemas are auto-generated from Zod validators via @asteasolutions/zod-to-openapi.
 */

import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { OpenAPIObject } from 'openapi3-ts/oas30';

// Import the OpenAPI module to register all schemas
import { generateOpenAPIDocument } from './openapi/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Generate the OpenAPI spec from registered schemas
export const swaggerSpec: OpenAPIObject = generateOpenAPIDocument();

export function setupSwagger(app: Express): void {
  // Serve swagger UI at /api/docs
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Ship API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'method',
    },
  }));

  // Serve the raw OpenAPI spec
  app.get('/api/openapi.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });

  app.get('/api/openapi.yaml', (req, res) => {
    res.setHeader('Content-Type', 'text/yaml');
    const yaml = jsonToYaml(swaggerSpec);
    res.send(yaml);
  });
}

// TRO-490: true unless the string is safe to emit bare — i.e. it cannot be
// mistaken by a YAML parser for another scalar type (bool/null/number),
// does not start/end with whitespace, and contains no characters that are
// structurally significant to YAML (`:`, `#`, quotes, flow indicators,
// etc. — the existing quoting regex already handles those separately for
// the common `\n` / `:` / `#` cases, but the full character class below is
// what decides "needs quoting" going forward).
function needsQuoting(s: string): boolean {
  const isSafeShape = /^[A-Za-z_](?:[A-Za-z0-9_ .\/()-]*[A-Za-z0-9_.\/()-])?$/.test(s);
  if (!isSafeShape) return true;
  const reserved = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '~']);
  return reserved.has(s.toLowerCase());
}

// Simple JSON to YAML converter (no external dependency needed)
export function jsonToYaml(obj: unknown, indent = 0): string {
  const spaces = '  '.repeat(indent);

  if (obj === null) return 'null';
  if (obj === undefined) return '';
  if (typeof obj === 'string') {
    // TRO-309 (CodeQL js/incomplete-sanitization): backslashes must be
    // escaped BEFORE quotes, and before this fix they were not escaped at
    // all. A value ending in a bare backslash right before the closing
    // quote (e.g. 'trailing:\\') produced `"trailing:\"` — a quoted YAML
    // scalar whose last two characters read as an *escaped* double quote,
    // not the terminator, leaving the string unterminated from the YAML
    // parser's point of view. Escaping backslash first (so a literal `\`
    // becomes `\\`) keeps the following `\"` an unambiguous, correctly
    // escaped quote.
    //
    // TRO-490: `JSON.stringify` produces exactly that escaping (and also
    // escapes newlines, tabs, control characters, etc.), and a JSON string
    // literal is valid YAML double-quoted scalar syntax, so reuse it
    // wholesale instead of hand-rolling escapes.
    return needsQuoting(obj) ? JSON.stringify(obj) : obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      if (item === undefined) return `${spaces}- null`;
      if (typeof item === 'object' && item !== null) {
        const entries = Array.isArray(item) ? item.length : Object.keys(item).length;
        if (entries === 0) {
          return `${spaces}- ${Array.isArray(item) ? '[]' : '{}'}`;
        }
        // jsonToYaml(item, 0) is UNindented; prefix the first line with the
        // array marker and every continuation line with one extra level
        // (spaces + 2) so nested content lines up under `- `.
        const lines = jsonToYaml(item, 0).split('\n');
        return [`${spaces}- ${lines[0]}`, ...lines.slice(1).map(l => `${spaces}  ${l}`)].join('\n');
      }
      return `${spaces}- ${jsonToYaml(item, indent)}`;
    }).join('\n');
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return '{}';
    return entries.map(([key, value]) => {
      const emittedKey = needsQuoting(key) ? JSON.stringify(key) : key;
      if (typeof value === 'object' && value !== null) {
        const size = Array.isArray(value) ? value.length : Object.keys(value).length;
        if (size === 0) {
          return `${spaces}${emittedKey}: ${Array.isArray(value) ? '[]' : '{}'}`;
        }
        return `${spaces}${emittedKey}:\n${jsonToYaml(value, indent + 1)}`;
      }
      return `${spaces}${emittedKey}: ${jsonToYaml(value, indent)}`;
    }).join('\n');
  }

  return String(obj);
}

// Generate static openapi.yaml file
export function generateOpenApiFile(): void {
  const yaml = jsonToYaml(swaggerSpec);
  const outputPath = path.join(__dirname, '..', 'openapi.yaml');
  fs.writeFileSync(outputPath, yaml, 'utf-8');
  console.log(`OpenAPI spec written to ${outputPath}`);

  // Also generate JSON version
  const jsonPath = path.join(__dirname, '..', 'openapi.json');
  fs.writeFileSync(jsonPath, JSON.stringify(swaggerSpec, null, 2), 'utf-8');
  console.log(`OpenAPI spec written to ${jsonPath}`);
}
