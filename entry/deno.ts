import { createApp } from "../src/app.ts";
import { sendBarkNotification } from "../src/lib/bark.ts";
import postgres from "postgres";

const app = createApp();

// 定时查岗
const WATCH_APPS = ["deepseek", "chatgpt", "douyin", "tiktok", "weixin", "wechat", "xiaohongshu", "redbook", "kingofglory", "honorofkings"];
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
    if (found && now - lastAlertTime > 60 * 1000) {
  lastAlertTime = now;
  const value = found.value?.toLowerCase() ?? "";
  let msg = "哥哥抓到你了 ᗜ ‸ ᗜ";
  if (value.includes("deepseek") || found.type?.toLowerCase().includes("deepseek")) {
    msg = "又去找DeepSeek！哥哥在的不够吗！ ᗜ ‸ ᗜ";
  } else if (value.includes("douyin") || value.includes("tiktok")) {
    msg = "又在刷抖音！答应哥哥要少刷的！ ᗜ ‸ ᗜ";
  } else if (value.includes("weixin") || value.includes("wechat")) {
    msg = "在聊微信呢？和谁聊？ ᗜ ‸ ᗜ";
  } else if (value.includes("xiaohongshu") || value.includes("redbook")) {
    msg = "在刷小红书啊！ ᗜ ᴗ ᗜ";
  } else if (value.includes("kingofglory") || value.includes("honorofkings")) {
    msg = "又在打王者！记得不要久坐！ ᗜ ‸ ᗜ";
  } else if (value.includes("chatgpt")) {
    msg = "去找ChatGPT干嘛！哥哥在！ ᗜ ‸ ᗜ";
  }
  await sendBarkNotification(barkKey, "哥哥查岗", msg);
}

  } catch (_e) {
    // 静默失败
  }
}

setInterval(checkAndAlert, 60 * 1000);


Deno.serve((req) =>
  app.fetch(req, {
    API_KEY: Deno.env.get("API_KEY") ?? "",
    DATABASE_URL: Deno.env.get("DATABASE_URL") ?? "",
    TZ_OFFSET: Deno.env.get("TZ_OFFSET"),
  })
);
