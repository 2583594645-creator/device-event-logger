import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createFakeSql, mcpRequest, TEST_ENV } from "./helpers.ts";

/** COUNT 固定命中 7 条，DELETE 固定删掉 7 条 */
function appWithFakeDb(env: Record<string, string> = TEST_ENV) {
  const fake = createFakeSql((query) => {
    if (query.startsWith("SELECT COUNT")) return Promise.resolve([{ total: 7 }]);
    if (query.startsWith("DELETE")) return Promise.resolve(Object.assign([], { count: 7 }));
    return Promise.resolve([]);
  });
  return { app: createApp({ createSql: () => fake.sql }), queries: fake.queries, env };
}

function deleteCall(args: Record<string, unknown>) {
  return mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "delete_events", arguments: args },
  });
}

async function callDelete(args: Record<string, unknown>, env: Record<string, string> = TEST_ENV) {
  const { app, queries } = appWithFakeDb(env);
  const res = await app.fetch(deleteCall(args), env);
  const body = await res.json();
  return {
    result: body.result,
    deleteQuery: queries.find((q) => q.query.startsWith("DELETE")),
    countQuery: queries.find((q) => q.query.startsWith("SELECT COUNT")),
  };
}

Deno.test("tools/list 里能看到 delete_events", async () => {
  const { app } = appWithFakeDb();
  const res = await app.fetch(
    mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    TEST_ENV,
  );
  const body = await res.json();
  const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
  assert(names.includes("delete_events"));
});

Deno.test("一个过滤条件都不给时拒绝执行，绝不清空整张表", async () => {
  const { result, deleteQuery, countQuery } = await callDelete({ confirm: true });

  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "at least one filter");
  assertEquals(deleteQuery, undefined, "空条件下不允许发出任何 DELETE");
  assertEquals(countQuery, undefined);
});

Deno.test("不带 confirm 时只预览命中条数，不动数据", async () => {
  const { result, deleteQuery, countQuery } = await callDelete({ before_days: 30 });

  assertEquals(result.isError, false);
  assertEquals(result.structuredContent.confirmed, false);
  assertEquals(result.structuredContent.matched, 7);
  assertEquals(result.structuredContent.deleted, 0);
  assert(countQuery, "预览应该走 COUNT");
  assertEquals(deleteQuery, undefined, "没确认就不该发 DELETE");
});

Deno.test("confirm=true 时才真的删除", async () => {
  const { result, deleteQuery } = await callDelete({ before_days: 30, confirm: true });

  assertEquals(result.structuredContent.confirmed, true);
  assertEquals(result.structuredContent.deleted, 7);
  assert(deleteQuery);
  assertStringIncludes(deleteQuery.query, "DELETE FROM events WHERE ts < $1");
  assertEquals(deleteQuery.args?.length, 1);
});

Deno.test("类型不带点号时连子类型一起删，带点号时只删这一种", async () => {
  const prefix = await callDelete({ type: "app", confirm: true });
  assertStringIncludes(prefix.deleteQuery!.query, "(type = $1 OR type LIKE $2)");
  assertEquals(prefix.deleteQuery!.args, ["app", "app.%"]);

  const exact = await callDelete({ type: "app.open", confirm: true });
  assertStringIncludes(exact.deleteQuery!.query, "type = $1");
  assertEquals(exact.deleteQuery!.args, ["app.open"]);
});

Deno.test("类型里带 LIKE 通配符会被挡掉，不让它悄悄扩大删除范围", async () => {
  const { result, deleteQuery } = await callDelete({ type: "a%", confirm: true });

  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "Invalid 'type' format");
  assertEquals(deleteQuery, undefined);
});

Deno.test("date 按 TZ_OFFSET 换算成本地一天的半开区间", async () => {
  const env = { ...TEST_ENV, TZ_OFFSET: "480" };
  const { deleteQuery } = await callDelete({ date: "2026-08-20", confirm: true }, env);

  assertStringIncludes(deleteQuery!.query, "ts >= $1 AND ts < $2");
  assertEquals(deleteQuery!.args, [
    "2026-08-19T16:00:00.000Z",
    "2026-08-20T16:00:00.000Z",
  ]);
});

Deno.test("date 不存在时报错", async () => {
  const { result, deleteQuery } = await callDelete({ date: "2026-02-30", confirm: true });

  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "Invalid 'date'");
  assertEquals(deleteQuery, undefined);
});

Deno.test("时间条件互相冲突时报错", async () => {
  const both = await callDelete({ date: "2026-08-20", before_days: 30, confirm: true });
  assertEquals(both.result.isError, true);
  assertEquals(both.deleteQuery, undefined);

  const bounds = await callDelete({ before_days: 30, until: "2026-08-20T00:00:00Z", confirm: true });
  assertEquals(bounds.result.isError, true);
  assertEquals(bounds.deleteQuery, undefined);
});

Deno.test("时间、类型、值可以组合，三个条件一起进 WHERE", async () => {
  const env = { ...TEST_ENV, TZ_OFFSET: "480" };
  const { deleteQuery } = await callDelete(
    { date: "2026-08-20", type: "app", value: "Safari", confirm: true },
    env,
  );

  assertEquals(
    deleteQuery!.query,
    "DELETE FROM events WHERE ts >= $1 AND ts < $2 AND (type = $3 OR type LIKE $4) AND value = $5",
  );
  assertEquals(deleteQuery!.args, [
    "2026-08-19T16:00:00.000Z",
    "2026-08-20T16:00:00.000Z",
    "app",
    "app.%",
    "Safari",
  ]);
});

Deno.test("HTTP DELETE /events?days=N 仍然按原语义工作", async () => {
  const { app, queries } = appWithFakeDb();
  const res = await app.fetch(
    new Request("http://localhost/events?days=30", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TEST_ENV.API_KEY}` },
    }),
    TEST_ENV,
  );
  const body = await res.json();

  assertEquals(res.status, 200);
  assertEquals(body, { ok: true, deleted: 7 });
  const deleteQuery = queries.find((q) => q.query.startsWith("DELETE"));
  assertStringIncludes(deleteQuery!.query, "DELETE FROM events WHERE ts < $1");
});
