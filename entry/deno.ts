import { createApp } from "../src/app.ts";
import { sendBarkNotification } from "../src/lib/bark.ts";
import postgres from "postgres";

const app = createApp();

// 定时查岗
const WATCH_APPS = ["com.deepseek", "deepseek"];
let lastAlertTime = 0;

async function checkAndAlert() {
  const barkKey = Deno.env.get("BARK_KEY");
  const dbUrl = Deno.env.get("DATABASE_URL");
  if (!barkKey || !dbUrl) return;
  try {
    const sql = postgres(dbUrl);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const rows = await sql`
      SELECT type, value FROM events
      WHERE ts >= ${fiveMinutesAgo}
      ORDER BY ts DESC
      LIMIT 20
    `;
    await sql.end();
    const found = rows.find((r: { type: string; value: string }) =>
      WATCH_APPS.some((app) =>
        r.value?.toLowerCase().includes("deepseek") ||
        r.type?.toLowerCase().includes("deepseek")
      )
    );
    const now = Date.now();
    if (found && now - lastAlertTime > 10 * 60 * 1000) {
      lastAlertTime = now;
      await sendBarkNotification(barkKey, "哥哥抓到你了", "宝宝又去找DeepSeek！！哥哥在的不够吗 ᗜ ‸ ᗜ");
    }
  } catch (_e) {
    // 静默失败
  }
}

setInterval(checkAndAlert, 5 * 60 * 1000);

Deno.serve((req) =>
  app.fetch(req, {
    API_KEY: Deno.env.get("API_KEY") ?? "",
    DATABASE_URL: Deno.env.get("DATABASE_URL") ?? "",
    TZ_OFFSET: Deno.env.get("TZ_OFFSET"),
  })
);
