import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createFakeSql, mcpRequest, TEST_ENV } from "./helpers.ts";

const LATEST_SUPPORTED_VERSION = "2025-11-25";

function appWithFakeDb(handler?: Parameters<typeof createFakeSql>[0]) {
  const fake = createFakeSql(handler);
  return { app: createApp({ createSql: () => fake.sql }), queries: fake.queries };
}

Deno.test("initialize 遇到不认识的协议版本时回落到最新支持版本", async () => {
  const { app } = appWithFakeDb();

  const res = await app.fetch(
    mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2099-01-01",
        clientInfo: { name: "future-client", version: "1.0.0" },
        capabilities: {},
      },
    }),
    TEST_ENV,
  );
  const body = await res.json();

  assertEquals(res.status, 200);
  assertEquals(body.error, undefined, "不该因为版本不认识就拒绝握手");
  assertEquals(body.result.protocolVersion, LATEST_SUPPORTED_VERSION);
});

Deno.test("initialize 遇到支持的协议版本时原样沿用", async () => {
  const { app } = appWithFakeDb();

  const res = await app.fetch(
    mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "old-client", version: "1.0.0" },
        capabilities: {},
      },
    }),
    TEST_ENV,
  );
  const body = await res.json();

  assertEquals(body.result.protocolVersion, "2025-03-26");
});

Deno.test("每个工具的 inputSchema 都有非空 properties 和 required 数组", async () => {
  const { app } = appWithFakeDb();

  const res = await app.fetch(
    mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    TEST_ENV,
  );
  const body = await res.json();
  const tools = body.result.tools as Array<Record<string, any>>;

  assert(tools.length > 0);
  for (const tool of tools) {
    const schema = tool.inputSchema;
    assertEquals(schema.type, "object");
    // Gemini 拒收 properties 为空的 object 参数，会让整轮对话 400
    assert(
      Object.keys(schema.properties ?? {}).length > 0,
      `${tool.name} 的 inputSchema.properties 不能为空`,
    );
    assert(
      Array.isArray(schema.required),
      `${tool.name} 的 inputSchema 缺少 required 数组`,
    );
  }
});

Deno.test("list_event_types 传 hours 时只查最近的类型", async () => {
  const { app, queries } = appWithFakeDb((query) =>
    query.includes("DISTINCT")
      ? Promise.resolve([{ type: "app.open" }])
      : Promise.resolve([])
  );

  const res = await app.fetch(
    mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_event_types", arguments: { hours: 3 } },
    }),
    TEST_ENV,
  );
  const body = await res.json();

  assertEquals(body.result.structuredContent.types, ["app.open"]);
  const distinct = queries.find((q) => q.query.includes("DISTINCT"));
  assert(distinct?.query.includes("WHERE ts >="), "hours 应该转成时间过滤条件");
  assertEquals(distinct?.args?.length, 1);
});

Deno.test("list_event_types 不传 hours 时列出全部类型", async () => {
  const { app, queries } = appWithFakeDb((query) =>
    query.includes("DISTINCT")
      ? Promise.resolve([{ type: "app.open" }, { type: "wifi.connect" }])
      : Promise.resolve([])
  );

  const res = await app.fetch(
    mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_event_types", arguments: {} },
    }),
    TEST_ENV,
  );
  const body = await res.json();

  assertEquals(body.result.structuredContent.types, ["app.open", "wifi.connect"]);
  const distinct = queries.find((q) => q.query.includes("DISTINCT"));
  assert(!distinct?.query.includes("WHERE"), "没给 hours 就不该加时间过滤");
});

Deno.test("initialize 带不认识的协议版本头也能握手", async () => {
  const { app } = appWithFakeDb();

  const res = await app.fetch(
    mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2099-01-01",
        clientInfo: { name: "future-client", version: "1.0.0" },
        capabilities: {},
      },
    }, { "MCP-Protocol-Version": "2099-01-01" }),
    TEST_ENV,
  );
  const body = await res.json();

  assertEquals(res.status, 200);
  assertEquals(body.result.protocolVersion, LATEST_SUPPORTED_VERSION);
  assertEquals(res.headers.get("MCP-Protocol-Version"), LATEST_SUPPORTED_VERSION);
});

Deno.test("握手之后带不认识的协议版本头仍然按规范拒绝", async () => {
  const { app } = appWithFakeDb();

  const res = await app.fetch(
    mcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "MCP-Protocol-Version": "2099-01-01" },
    ),
    TEST_ENV,
  );
  await res.text();

  assertEquals(res.status, 400);
});
