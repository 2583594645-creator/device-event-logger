import { assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createFakeSql, TEST_ENV } from "./helpers.ts";

/** GET /events：认证通过会走到查询并返回 200，没通过则 401 */
function eventsRequest(authorization?: string): Request {
  return new Request("http://localhost/events?hours=1", {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

function createTestApp() {
  const { sql } = createFakeSql((query) =>
    Promise.resolve(query.includes("COUNT(*)") ? [{ total: 0 }] : [])
  );
  return createApp({ createSql: () => sql });
}

async function statusFor(authorization?: string): Promise<number> {
  const res = await createTestApp().fetch(eventsRequest(authorization), TEST_ENV);
  await res.text();
  return res.status;
}

Deno.test("Authorization 带 Bearer 前缀可以通过", async () => {
  assertEquals(await statusFor(`Bearer ${TEST_ENV.API_KEY}`), 200);
});

Deno.test("Authorization 只填纯密钥也可以通过", async () => {
  assertEquals(
    await statusFor(TEST_ENV.API_KEY),
    200,
    "有的客户端填不了 Bearer 前缀，只认前缀会把它们全挡在门外",
  );
});

Deno.test("Bearer 前缀大小写和多余空格不影响认证", async () => {
  assertEquals(await statusFor(`bearer ${TEST_ENV.API_KEY}`), 200);
  assertEquals(await statusFor(`  Bearer   ${TEST_ENV.API_KEY}  `), 200);
});

Deno.test("密钥不对一律 401", async () => {
  const rejected = [
    undefined,
    "",
    "Bearer ",
    "Bearer wrong-key",
    "wrong-key",
    `Bearer ${TEST_ENV.API_KEY}-extra`,
  ];
  for (const header of rejected) {
    assertEquals(await statusFor(header), 401, `不该放行：${JSON.stringify(header)}`);
  }
});
