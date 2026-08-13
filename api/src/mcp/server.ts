#!/usr/bin/env node
/**
 * Ship MCP Server - Auto-generated from OpenAPI spec
 *
 * This server dynamically generates MCP tools by fetching the OpenAPI specification
 * from a running Ship instance. As the API changes, tools automatically stay in sync.
 *
 * Configuration is loaded from ~/.claude/.env:
 *   SHIP_API_TOKEN=xxx
 *   SHIP_URL=https://ship.example.com
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ============== Configuration ==============

interface Config {
  token: string;
  url: string;
}

function loadConfig(): Config {
  const envPath = join(homedir(), ".claude", ".env");

  if (!existsSync(envPath)) {
    throw new Error("~/.claude/.env not found. Run /ship:auth first.");
  }

  const content = readFileSync(envPath, "utf-8");
  const lines = content.split("\n");

  let token = "";
  let url = "http://localhost:3001";

  for (const line of lines) {
    if (line.startsWith("SHIP_API_TOKEN=")) {
      token = line.substring("SHIP_API_TOKEN=".length).trim();
    } else if (line.startsWith("SHIP_URL=")) {
      url = line.substring("SHIP_URL=".length).trim();
    }
  }

  if (!token) {
    throw new Error("SHIP_API_TOKEN not found in ~/.claude/.env");
  }

  return { token, url };
}

// ============== OpenAPI Types (inline to avoid dependencies) ==============

export interface OpenAPIObject {
  paths?: Record<string, PathItemObject>;
  components?: {
    schemas?: Record<string, SchemaObject>;
  };
}

interface PathItemObject {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
}

export interface ServerObject {
  url: string;
  description?: string;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: ParameterObject[];
  requestBody?: {
    content?: {
      "application/json"?: {
        schema?: SchemaObject | ReferenceObject;
      };
    };
  };
  // TRO-551: an operation-level `servers` override (OpenAPI 3.0 §4.8.10.1)
  // for routes registered outside the global `/api` prefix — see
  // `api/src/openapi/registry.ts`'s `ROOT_SERVER` export, which is the
  // writer half of this contract. When present, this REPLACES the `/api`
  // default for this operation (`resolveServerPrefix` below), it does not
  // add to it.
  servers?: ServerObject[];
}

interface ParameterObject {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: SchemaObject | ReferenceObject;
}

interface SchemaObject {
  type?: string;
  description?: string;
  properties?: Record<string, SchemaObject | ReferenceObject>;
  required?: string[];
  items?: SchemaObject | ReferenceObject;
  enum?: unknown[];
}

interface ReferenceObject {
  $ref: string;
}

// ============== Tool Generation ==============

export interface ToolOperation {
  method: string;
  path: string;
  operation: OperationObject;
}

// Map of tool name -> operation details
const toolOperations = new Map<string, ToolOperation>();

// Store config globally for use in executeToolCall
let CONFIG: Config;

/**
 * Fetch OpenAPI spec from the Ship instance
 */
async function fetchOpenAPISpec(url: string): Promise<OpenAPIObject> {
  const specUrl = `${url}/api/openapi.json`;
  console.error(`Fetching OpenAPI spec from ${specUrl}...`);

  const response = await fetch(specUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<OpenAPIObject>;
}

/**
 * Convert path to operationId-style string
 * e.g., "/accountability/action-items" -> "accountability_action_items"
 * e.g., "/projects/{id}" -> "projects_by_id"
 * e.g., "/issues/{id}/children" -> "issues_children"
 */
function pathToOperationId(method: string, path: string): string {
  // Replace {param} with descriptive suffix to avoid collisions
  // e.g., /projects/{id} vs /projects need different operationIds
  let cleanPath = path;

  // Check if path ends with a parameter like /{id}
  if (/\/\{[^}]+\}$/.test(path)) {
    cleanPath = path.replace(/\/\{[^}]+\}$/, "_by_id");
  }

  // Replace remaining {param} in middle of path with empty string
  cleanPath = cleanPath
    .replace(/\{[^}]+\}/g, "") // Remove middle {param}
    .replace(/\//g, "_") // / -> _
    .replace(/-/g, "_") // - -> _
    .replace(/_+/g, "_") // Collapse multiple _
    .replace(/^_|_$/g, ""); // Trim leading/trailing _

  return `${method}_${cleanPath}`;
}

/**
 * Convert OpenAPI operationId to MCP tool name
 */
function toToolName(operationId: string): string {
  if (operationId.includes("_")) {
    return `ship_${operationId}`;
  }
  return `ship_${operationId.replace(/([A-Z])/g, "_$1").toLowerCase()}`;
}

/**
 * Check if a schema is a reference object
 */
function isReference(
  schema: SchemaObject | ReferenceObject
): schema is ReferenceObject {
  return "$ref" in schema;
}

/**
 * Resolve a $ref to its schema definition
 */
function resolveRef(
  ref: string,
  spec: OpenAPIObject
): SchemaObject | undefined {
  const parts = ref.split("/");
  if (
    parts[0] !== "#" ||
    parts[1] !== "components" ||
    parts[2] !== "schemas"
  ) {
    return undefined;
  }
  const schemaName = parts[3];
  if (!schemaName || !spec.components?.schemas) {
    return undefined;
  }
  return spec.components.schemas[schemaName] as SchemaObject | undefined;
}

/**
 * Convert OpenAPI schema to JSON Schema for MCP tool input
 */
function openApiToJsonSchema(
  schema: SchemaObject | ReferenceObject | undefined,
  spec: OpenAPIObject
): Record<string, unknown> {
  if (!schema) {
    return { type: "object", properties: {} };
  }

  if (isReference(schema)) {
    const resolved = resolveRef(schema.$ref, spec);
    if (resolved) {
      return openApiToJsonSchema(resolved, spec);
    }
    return { type: "object", properties: {} };
  }

  const result: Record<string, unknown> = {};

  if (schema.type) {
    result.type = schema.type;
  }

  if (schema.description) {
    result.description = schema.description;
  }

  if (schema.enum) {
    result.enum = schema.enum;
  }

  if (schema.properties) {
    result.properties = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      (result.properties as Record<string, unknown>)[key] = openApiToJsonSchema(
        prop as SchemaObject | ReferenceObject,
        spec
      );
    }
  }

  if (schema.required) {
    result.required = schema.required;
  }

  if (schema.items) {
    result.items = openApiToJsonSchema(
      schema.items as SchemaObject | ReferenceObject,
      spec
    );
  }

  return result;
}

/**
 * Build MCP tool input schema from OpenAPI operation
 */
function buildInputSchema(
  operation: OperationObject,
  spec: OpenAPIObject
): Tool["inputSchema"] {
  const properties: Record<string, object> = {};
  const required: string[] = [];

  // Add path and query parameters
  if (operation.parameters) {
    for (const param of operation.parameters) {
      if (param.name && param.schema) {
        const paramSchema = openApiToJsonSchema(
          param.schema as SchemaObject | ReferenceObject,
          spec
        );
        if (param.description) {
          paramSchema.description = param.description;
        }
        properties[param.name] = paramSchema as object;
        if (param.required) {
          required.push(param.name);
        }
      }
    }
  }

  // Add request body properties
  if (operation.requestBody?.content?.["application/json"]?.schema) {
    const bodySchema = openApiToJsonSchema(
      operation.requestBody.content["application/json"]
        .schema as SchemaObject | ReferenceObject,
      spec
    );

    if (bodySchema.properties && typeof bodySchema.properties === "object") {
      for (const [key, value] of Object.entries(bodySchema.properties)) {
        properties[key] = value as object;
      }
    }
    if (Array.isArray(bodySchema.required)) {
      required.push(...bodySchema.required);
    }
  }

  return {
    type: "object" as const,
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Generate MCP tools from OpenAPI spec
 */
export function generateTools(openApiSpec: OpenAPIObject): Tool[] {
  const tools: Tool[] = [];

  for (const [path, pathItem] of Object.entries(openApiSpec.paths || {})) {
    if (!pathItem) continue;

    const methods = ["get", "post", "put", "patch", "delete"] as const;

    for (const method of methods) {
      const operation = pathItem[method] as OperationObject | undefined;
      if (!operation) continue;

      const operationId =
        operation.operationId || pathToOperationId(method, path);
      const toolName = toToolName(operationId);
      const description = [
        operation.summary,
        operation.description,
        `[${method.toUpperCase()} ${path}]`,
      ]
        .filter(Boolean)
        .join("\n\n");

      toolOperations.set(toolName, { method, path, operation });

      tools.push({
        name: toolName,
        description,
        inputSchema: buildInputSchema(operation, openApiSpec),
      });
    }
  }

  return tools;
}

// TRO-551: every operation used to be assumed `/api`-relative — this was
// hardcoded directly into the URL template below. That broke the moment a
// route was registered outside `/api` (e.g. `/oauth/authorize`, mounted at
// the application root in `app.ts`): the generated MCP tool still called
// `${url}/api/oauth/authorize`, which 404s, silently, on every invocation.
const DEFAULT_SERVER_PREFIX = "/api";

/**
 * Resolve the URL prefix for a given operation. Most operations have no
 * `servers` override and use the registry's global `/api` base
 * (`api/src/openapi/registry.ts`). An operation registered with a `servers`
 * override — the `ROOT_SERVER` convention that export documents — uses that
 * server's `url` instead, exactly matching OpenAPI 3.0's own semantics: an
 * operation-level `servers` array REPLACES the document-level one for that
 * operation, it does not add to it.
 *
 * Exported for the regression test — this is the fix's actual mechanism,
 * kept a pure function precisely so it can be asserted on directly rather
 * than only through a live HTTP call.
 */
export function resolveServerPrefix(operation: OperationObject): string {
  const override = operation.servers?.[0]?.url;
  if (override === undefined) {
    return DEFAULT_SERVER_PREFIX;
  }
  // Strip exactly one trailing slash so `prefix + path` (path always starts
  // with "/") never produces a double slash. A root-mount override of ""
  // (registry.ts's ROOT_SERVER) is untouched by this — nothing to strip.
  return override.endsWith("/") ? override.slice(0, -1) : override;
}

/**
 * Build the request URL and body params for a tool call, without making the
 * HTTP request itself. Split out from `executeToolCall` so the URL-building
 * logic — including the `/api` vs. per-operation `servers` override — is
 * directly testable without a live server or the module-level `CONFIG`.
 */
export function buildRequestUrl(
  baseUrl: string,
  toolOp: ToolOperation,
  args: Record<string, unknown>
): { url: string; bodyParams: Record<string, unknown> } {
  const { path, operation } = toolOp;

  // Build URL with path parameters replaced
  let url = `${baseUrl}${resolveServerPrefix(operation)}${path}`;
  const queryParams: Record<string, string> = {};
  const bodyParams: Record<string, unknown> = {};

  // Categorize arguments into path, query, and body params
  if (operation.parameters) {
    for (const param of operation.parameters) {
      const value = args[param.name];
      if (value !== undefined) {
        if (param.in === "path") {
          url = url.replace(`{${param.name}}`, encodeURIComponent(String(value)));
        } else if (param.in === "query") {
          queryParams[param.name] = String(value);
        }
      }
    }
  }

  // Remaining args go to body (for POST/PUT/PATCH)
  const paramNames = new Set(
    (operation.parameters || []).map((p) => p.name)
  );
  for (const [key, value] of Object.entries(args)) {
    if (!paramNames.has(key)) {
      bodyParams[key] = value;
    }
  }

  // Build query string
  const queryString = new URLSearchParams(queryParams).toString();
  if (queryString) {
    url += `?${queryString}`;
  }

  return { url, bodyParams };
}

/**
 * Execute an API call based on tool name and arguments
 */
async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const toolOp = toolOperations.get(toolName);
  if (!toolOp) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const { method } = toolOp;
  const { url, bodyParams } = buildRequestUrl(CONFIG.url, toolOp, args);

  // Make the request
  const fetchOptions: RequestInit = {
    method: method.toUpperCase(),
    headers: {
      Authorization: `Bearer ${CONFIG.token}`,
      "Content-Type": "application/json",
    },
  };

  if (
    ["post", "put", "patch"].includes(method) &&
    Object.keys(bodyParams).length > 0
  ) {
    fetchOptions.body = JSON.stringify(bodyParams);
  }

  console.error(`[MCP] ${method.toUpperCase()} ${url}`);

  const response = await fetch(url, fetchOptions);

  // Handle non-OK responses before trying to parse JSON
  if (!response.ok) {
    const text = await response.text();
    console.error(`[MCP] Error ${response.status}: ${text.substring(0, 200)}`);

    // Try to parse as JSON for structured error, fall back to text
    let errorMessage: string;
    try {
      const errorData = JSON.parse(text);
      errorMessage = JSON.stringify(errorData);
    } catch {
      errorMessage = text.substring(0, 500);
    }
    throw new Error(`API error ${response.status}: ${errorMessage}`);
  }

  const data = await response.json();
  return data;
}

// ============== Main ==============

async function main() {
  // Load configuration from ~/.claude/.env
  CONFIG = loadConfig();

  // Fetch OpenAPI spec from Ship instance
  const openApiSpec = await fetchOpenAPISpec(CONFIG.url);

  // Generate tools from spec
  const mcpTools = generateTools(openApiSpec);
  console.error(`Generated ${mcpTools.length} tools from OpenAPI spec`);

  // Create the MCP server
  const server = new Server(
    {
      name: "ship",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: mcpTools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await executeToolCall(
        name,
        (args || {}) as Record<string, unknown>
      );

      return {
        content: [
          {
            type: "text",
            text:
              typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        content: [
          {
            type: "text",
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Connect transport and start
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Ship MCP server running on ${CONFIG.url}`);
}

// Only run when executed directly (`tsx src/mcp/server.ts` / the `mcp` pnpm
// script), not when imported by the regression test — same guard
// `api/src/db/postgresReachable.ts` and `verifyMigrations.ts` use, for the
// identical reason: `main()` calls `loadConfig()`, which throws (and would
// otherwise `process.exit(1)` the whole test runner) unless
// `~/.claude/.env` happens to exist on the machine running the suite.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Failed to start Ship MCP server:", error);
    process.exit(1);
  });
}
