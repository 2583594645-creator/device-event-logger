import type { Context } from "hono";
import type postgres from "postgres";
import type { Env, Vars, JsonRpcId, JsonRpcMessage } from "../types.ts";
import { queryEvents, parseEventQueryFromToolArgs, buildEventSummaryText } from "./queries.ts";
import { withRetry } from "./db.ts";

const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";
// 新版本排在最前，客户端报了不认识的版本时用它回落
const SUPPORTED_MCP_PROTOCOL_VERSION_LIST = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];
const LATEST_MCP_PROTOCOL_VERSION = SUPPORTED_MCP_PROTOCOL_VERSION_LIST[0];
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set(SUPPORTED_MCP_PROTOCOL_VERSION_LIST);

const MCP_SERVER_INFO = {
  name: "device-event-logger",
  title: "User Device Event Logger",
  version: "1.0.0",
  description: "Query user device event records from a database. Read-only.",
};

const QUERY_EVENTS_TOOL = {
  name: "query_events",
  title: "Query Events",
  description: "Query event records by time range, type, and value.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: {
        type: "number",
        description: "Look back N hours. Defaults to 6 when since is omitted.",
        minimum: 0.001,
      },
      since: {
        type: "string",
        description: "Start time in ISO 8601 format. Overrides the default hours window.",
      },
      until: {
        type: "string",
        description: "End time in ISO 8601 format. Defaults to now.",
      },
      type: {
        type: "string",
        description:
          "Event type filter (dot-separated lowercase alphanumeric, e.g. 'app.open'). Prefix match when no dot is present; exact match otherwise. Use the list_event_types tool to discover available types.",
      },
      value: {
        type: "string",
        description: "Exact value filter.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of events to return. Default 100, max 1000.",
        minimum: 1,
        maximum: 1000,
      },
      offset: {
        type: "integer",
        description: "Pagination offset. Default 0.",
        minimum: 0,
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      total: { type: "integer" },
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "integer" },
            type: { type: "string" },
            value: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            ts: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
          },
          required: ["id", "type", "value", "ts"],
        },
      },
    },
    required: ["total", "events"],
  },
};

const LIST_EVENT_TYPES_TOOL = {
  name: "list_event_types",
  title: "List Event Types",
  description:
    "List all distinct event types currently stored in the database. Use this to discover available types before querying events.",
  // properties 必须留至少一个字段：Gemini 会拒收 properties 为空的 object 参数，
  // 整轮对话都会 400，工具再也调不动
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: {
        type: "number",
        description:
          "Only list types seen in the last N hours. Omit to list every type ever recorded.",
        minimum: 0.001,
      },
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      types: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["types"],
  },
};

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function isJsonRpcRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && Object.prototype.hasOwnProperty.call(message, "id");
}

function isJsonRpcNotification(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && !Object.prototype.hasOwnProperty.call(message, "id");
}

function isJsonRpcResponse(message: JsonRpcMessage): boolean {
  return Object.prototype.hasOwnProperty.call(message, "result") ||
    Object.prototype.hasOwnProperty.call(message, "error");
}

/** 响应头里回显的协议版本：没带头按规范默认，带了不认识的版本就报自己支持的最新版 */
function resolveResponseProtocolVersion(header?: string): string {
  if (!header) return DEFAULT_MCP_PROTOCOL_VERSION;
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.has(header) ? header : LATEST_MCP_PROTOCOL_VERSION;
}

/** 握手请求（可能被包在批量里）在版本协商完成前不该因为版本头被拒 */
function containsInitialize(body: unknown): boolean {
  const isInitialize = (item: unknown) =>
    !!item && typeof item === "object" &&
    (item as JsonRpcMessage).method === "initialize";
  return Array.isArray(body) ? body.some(isInitialize) : isInitialize(body);
}

async function callQueryEventsTool(args: Record<string, unknown>, sql: postgres.Sql, offsetMinutes: number) {
  const parsed = parseEventQueryFromToolArgs(args);
  if (typeof parsed === "string") {
    return { content: [{ type: "text", text: parsed }], isError: true };
  }
  try {
    const result = await queryEvents(parsed, sql, offsetMinutes);
    return {
      content: [{ type: "text", text: buildEventSummaryText(result.events, result.total) }],
      structuredContent: result,
      isError: false,
    };
  } catch (error) {
    console.error("MCP query_events failed:", error);
    return { content: [{ type: "text", text: "Database error while querying events." }], isError: true };
  }
}

async function callListEventTypesTool(args: Record<string, unknown>, sql: postgres.Sql) {
  const rawHours = args.hours;
  let since: string | null = null;
  if (rawHours != null && rawHours !== "") {
    const hours = Number(rawHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { content: [{ type: "text", text: "Invalid 'hours'" }], isError: true };
    }
    since = new Date(Date.now() - hours * 3600_000).toISOString();
  }

  try {
    const rows = await withRetry(() =>
      since
        ? sql.unsafe("SELECT DISTINCT type FROM events WHERE ts >= $1 ORDER BY type", [since])
        : sql.unsafe("SELECT DISTINCT type FROM events ORDER BY type")
    );
    const types = rows.map((r: Record<string, unknown>) => String(r.type));
    return {
      content: [{ type: "text", text: types.length ? types.join("\n") : "No event types found." }],
      structuredContent: { types },
      isError: false,
    };
  } catch (error) {
    console.error("MCP list_event_types failed:", error);
    return { content: [{ type: "text", text: "Database error while listing event types." }], isError: true };
  }
}

async function handleMcpRequest(message: JsonRpcMessage, sql: postgres.Sql, offsetMinutes: number) {
  const id = (message.id ?? null) as JsonRpcId;
  const method = typeof message.method === "string" ? message.method : "";
  const params = (message.params && typeof message.params === "object")
    ? message.params as Record<string, unknown>
    : {};

  switch (method) {
    case "initialize": {
      const requestedVersion = typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : "";
      // 客户端报了不认识的版本就回落到自己支持的最新版，由客户端决定接不接受。
      // 直接返回错误会让升级了协议版本的客户端彻底连不上。
      const negotiatedVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : LATEST_MCP_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          "This server provides read-only access to user device event records. Use list_event_types to discover available event types, then use query_events to query records by time range, type, and value.",
      });
    }
    case "notifications/initialized":
      return null;
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, {
        tools: [QUERY_EVENTS_TOOL, LIST_EVENT_TYPES_TOOL],
      });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object")
        ? params.arguments as Record<string, unknown>
        : {};
      if (name === LIST_EVENT_TYPES_TOOL.name) {
        return jsonRpcResult(id, await callListEventTypesTool(args, sql));
      }
      if (name !== QUERY_EVENTS_TOOL.name) {
        return jsonRpcError(id, -32601, `Unknown tool: ${name || "(empty)"}`);
      }
      return jsonRpcResult(id, await callQueryEventsTool(args, sql, offsetMinutes));
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method || "(empty)"}`);
  }
}

export async function handleMcpPost(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const sql = c.var.sql;
  const offsetMinutes = c.var.offsetMinutes;

  const version = c.req.header("mcp-protocol-version")?.trim();
  const protocolVersion = resolveResponseProtocolVersion(version);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  // Validate protocol version header —— 握手请求除外，那会儿版本还没协商完
  if (version && !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(version) && !containsInitialize(body)) {
    return c.json({ error: `Unsupported MCP protocol version: ${version}` }, 400);
  }

  // Batch handling — array of JSON-RPC messages
  if (Array.isArray(body)) {
    if (!body.length) {
      c.header("MCP-Protocol-Version", protocolVersion);
      return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
    }
    const responses: unknown[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object") {
        responses.push(jsonRpcError(null, -32600, "Invalid Request"));
        continue;
      }
      const message = item as JsonRpcMessage;
      if (isJsonRpcNotification(message) || isJsonRpcResponse(message)) continue;
      if (!isJsonRpcRequest(message)) {
        responses.push(jsonRpcError(null, -32600, "Invalid Request"));
        continue;
      }
      responses.push(await handleMcpRequest(message, sql, offsetMinutes));
    }
    if (!responses.length) {
      return c.body(null, 202);
    }
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(responses);
  }

  // Single message handling
  if (!body || typeof body !== "object") {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
  }
  const message = body as JsonRpcMessage;
  if (isJsonRpcNotification(message) || isJsonRpcResponse(message)) {
    return c.body(null, 202);
  }
  if (!isJsonRpcRequest(message)) {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
  }
  const response = await handleMcpRequest(message, sql, offsetMinutes);
  if (response == null) {
    return c.body(null, 202);
  }
  c.header("MCP-Protocol-Version", protocolVersion);
  return c.json(response);
}
