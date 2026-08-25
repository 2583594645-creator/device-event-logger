 import { sendBarkNotification } from "./bark.ts";
import type { Context } from "hono";
import type postgres from "postgres";
import type { Env, Vars, JsonRpcId, JsonRpcMessage } from "../types.ts";
import {
  buildEventSummaryText,
  countMatchingEvents,
  deleteEvents,
  describeDeleteFilter,
  parseDeleteFilter,
  parseEventQueryFromToolArgs,
  queryEvents,
} from "./queries.ts";
import { withRetry } from "./db.ts";

const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";
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
  version: "1.1.0",
  description: "Query and prune user device event records stored in a database.",
};

const QUERY_EVENTS_TOOL = {
  name: "query_events",
  title: "Query Events",
  description: "Query event records by time range, type, and value.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: { type: "number", description: "Look back N hours. Defaults to 6 when since is omitted.", minimum: 0.001 },
      since: { type: "string", description: "Start time in ISO 8601 format. Overrides the default hours window." },
      until: { type: "string", description: "End time in ISO 8601 format. Defaults to now." },
      type: { type: "string", description: "Event type filter (dot-separated lowercase alphanumeric)." },
      value: { type: "string", description: "Exact value filter." },
      limit: { type: "integer", description: "Maximum number of events to return. Default 100, max 1000.", minimum: 1, maximum: 1000 },
      offset: { type: "integer", description: "Pagination offset. Default 0.", minimum: 0 },
    },
  },
};

const LIST_EVENT_TYPES_TOOL = {
  name: "list_event_types",
  title: "List Event Types",
  description: "List all distinct event types currently stored in the database.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: { type: "number", description: "Only list types seen in the last N hours.", minimum: 0.001 },
    },
    required: [],
  },
};

const DELETE_EVENTS_TOOL = {
  name: "delete_events",
  title: "Delete Events",
  description: "Permanently delete event records. Always run once without confirm to preview first.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      since: { type: "string", description: "Start of the range to delete, ISO 8601. Inclusive." },
      until: { type: "string", description: "End of the range to delete, ISO 8601. Inclusive." },
      date: { type: "string", description: "Delete one local calendar day, written as YYYY-MM-DD." },
      type: { type: "string", description: "Event type filter (dot-separated lowercase alphanumeric)." },
      value: { type: "string", description: "Exact value filter, e.g. one specific app name." },
      before_days: { type: "number", description: "Delete records older than N days from now.", minimum: 0.001 },
      confirm: { type: "boolean", description: "Must be true to actually delete. Omit to preview only." },
    },
    required: [],
  },
};

const BARK_NOTIFY_TOOL = {
  name: "send_bark_notification",
  title: "Send Bark Notification",
  description: "Push a notification to the user iPhone via Bark app.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", description: "Notification title." },
      body: { type: "string", description: "Notification body text." },
    },
    required: ["title", "body"],
  },
};

type ToolCallResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

type JsonRpcRequest = { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown };
type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: unknown };

function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && "method" in msg;
}
function isJsonRpcNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return !("id" in msg) && "method" in msg;
}
function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function callQueryEventsTool(args: Record<string, unknown>, sql: postgres.Sql, offsetMinutes: number): Promise<ToolCallResult> {
  try {
    const query = parseEventQueryFromToolArgs(args, offsetMinutes);
    const events = await withRetry(() => queryEvents(sql, query));
    const total = await withRetry(() => countMatchingEvents(sql, query));
    const text = buildEventSummaryText(events, total, query);
    return {
      content: [{ type: "text", text }],
      structuredContent: { total, events: events.map((e) => ({ id: e.id, type: e.type, value: e.value, ts: e.ts })) },
      isError: false,
    };
  } catch (error) {
    return { content: [{ type: "text", text: "Database error: " + String(error) }], isError: true };
  }
}

async function callListEventTypesTool(args: Record<string, unknown>, sql: postgres.Sql): Promise<ToolCallResult> {
  try {
    const hours = typeof args.hours === "number" ? args.hours : undefined;
    const types = await withRetry(() => {
      if (hours !== undefined) {
        return sql<{ type: string }[]>`SELECT DISTINCT type FROM events WHERE ts >= NOW() - ${hours} * INTERVAL '1 hour' ORDER BY type`;
      }
      return sql<{ type: string }[]>`SELECT DISTINCT type FROM events ORDER BY type`;
    });
    const list = types.map((r) => r.type);
    return {
      content: [{ type: "text", text: list.length ? list.join("\n") : "No event types found." }],
      structuredContent: { types: list },
      isError: false,
    };
  } catch (error) {
    return { content: [{ type: "text", text: "Database error: " + String(error) }], isError: true };
  }
}

async function callDeleteEventsTool(args: Record<string, unknown>, sql: postgres.Sql, offsetMinutes: number): Promise<ToolCallResult> {
  try {
    const filter = parseDeleteFilter(args, offsetMinutes);
    const description = describeDeleteFilter(filter, offsetMinutes);
    const confirm = args.confirm === true;
    if (!confirm) {
      const matched = await withRetry(() => countMatchingEvents(sql, { filter }));
      return {
        content: [{ type: "text", text: "Preview: " + matched + " records match. Re-run with confirm=true to delete." }],
        structuredContent: { confirmed: false, matched, filter: description },
        isError: false,
      };
    }
    const deleted = await withRetry(() => deleteEvents(filter, sql));
    return {
      content: [{ type: "text", text: "Deleted " + deleted.matched + " records." }],
      structuredContent: { confirmed: true, matched: deleted.matched, deleted: deleted.deleted, filter: description },
      isError: false,
    };
  } catch (error) {
    return { content: [{ type: "text", text: "Database error: " + String(error) }], isError: true };
  }
}

async function callBarkNotifyTool(args: Record<string, unknown>): Promise<ToolCallResult> {
  const barkKey = Deno.env.get("BARK_KEY");
  if (!barkKey) {
    return { content: [{ type: "text", text: "Bark failed: BARK_KEY not set." }], structuredContent: { success: false }, isError: true };
  }
  const title = args.title;
  const body = args.body;
  if (typeof title !== "string" || !title.trim()) {
    return { content: [{ type: "text", text: "Bark failed: title required." }], structuredContent: { success: false }, isError: true };
  }
  if (typeof body !== "string" || !body.trim()) {
    return { content: [{ type: "text", text: "Bark failed: body required." }], structuredContent: { success: false }, isError: true };
  }
  try {
    await sendBarkNotification(barkKey, title, body);
    return { content: [{ type: "text", text: "Bark sent: " + title + " - " + body }], structuredContent: { success: true }, isError: false };
  } catch (error) {
    return { content: [{ type: "text", text: "Bark failed: " + String(error) }], structuredContent: { success: false }, isError: true };
  }
}

async function handleMcpRequest(message: JsonRpcRequest, sql: postgres.Sql, offsetMinutes: number, protocolVersion: string): Promise<JsonRpcResponse | null> {
  const id = (message.id ?? null) as JsonRpcId;
  const method = typeof message.method === "string" ? message.method : "";
  const params = (message.params && typeof message.params === "object") ? message.params as Record<string, unknown> : {};

  switch (method) {
    case "initialize": {
      const requestedVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_MCP_PROTOCOL_VERSION;
      const negotiatedVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requestedVersion) ? requestedVersion : LATEST_MCP_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: "This server exposes user device event records. Use list_event_types to discover available types. delete_events removes records permanently: always run it once without confirm to preview first.",
      });
    }
    case "notifications/initialized": return null;
    case "ping": return jsonRpcResult(id, {});
    case "tools/list": return jsonRpcResult(id, { tools: [QUERY_EVENTS_TOOL, LIST_EVENT_TYPES_TOOL, DELETE_EVENTS_TOOL, BARK_NOTIFY_TOOL] });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object") ? params.arguments as Record<string, unknown> : {};
      if (name === LIST_EVENT_TYPES_TOOL.name) return jsonRpcResult(id, await callListEventTypesTool(args, sql));
      if (name === DELETE_EVENTS_TOOL.name) return jsonRpcResult(id, await callDeleteEventsTool(args, sql, offsetMinutes));
      if (name === BARK_NOTIFY_TOOL.name) return jsonRpcResult(id, await callBarkNotifyTool(args));
      if (name !== QUERY_EVENTS_TOOL.name) return jsonRpcError(id, -32601, "Unknown tool: " + (name || "(empty)"));
      return jsonRpcResult(id, await callQueryEventsTool(args, sql, offsetMinutes));
    }
    default: return jsonRpcError(id, -32601, "Unknown method: " + method);
  }
}

export async function handleMcpPost(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const sql = c.get("sql");
  const offsetMinutes = c.get("offsetMinutes");
  const protocolVersion = c.get("protocolVersion") ?? DEFAULT_MCP_PROTOCOL_VERSION;
  const body = await c.req.json().catch(() => null);

  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object") { responses.push(jsonRpcError(null, -32600, "Invalid Request")); continue; }
      const message = item as JsonRpcMessage;
      if (!isJsonRpcRequest(message)) { responses.push(jsonRpcError(null, -32600, "Invalid Request")); continue; }
      const r = await handleMcpRequest(message, sql, offsetMinutes, protocolVersion);
      if (r !== null) responses.push(r);
    }
    if (!responses.length) return c.body(null, 202);
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(responses);
  }

  if (!body || typeof body !== "object") {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"));
  }
  const message = body as JsonRpcMessage;
  if (isJsonRpcNotification(message)) return c.body(null, 202);
  if (!isJsonRpcRequest(message)) {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"));
  }
  const response = await handleMcpRequest(message, sql, offsetMinutes, protocolVersion);
  if (response === null) return c.body(null, 202);
  c.header("MCP-Protocol-Version", protocolVersion);
  return c.json(response);
}
