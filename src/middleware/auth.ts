import type { Context, Next } from "hono";
import type { Env, Vars } from "../types.ts";

const BEARER_PREFIX = "bearer ";

/**
 * 从 Authorization 头里取出密钥。
 * 有的客户端只允许填一个纯 key，不会补 "Bearer " 前缀，所以两种写法都收。
 */
function extractToken(header: string | undefined): string {
  const value = header?.trim() ?? "";
  return value.toLowerCase().startsWith(BEARER_PREFIX)
    ? value.slice(BEARER_PREFIX.length).trim()
    : value;
}

export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  next: Next,
): Promise<Response | void> {
  const token = extractToken(c.req.header("Authorization"));
  if (!token || token !== c.env.API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}
