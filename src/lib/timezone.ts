/** 默认 +08:00 */
export const DEFAULT_OFFSET_MINUTES = 480;

// 现实中的时区范围：UTC-12:00 到 UTC+14:00
const MIN_OFFSET_MINUTES = -720;
const MAX_OFFSET_MINUTES = 840;

/**
 * TZ_OFFSET 的单位是分钟，这样 +05:30、+05:45 这类非整点时区也能直接写（330、345）。
 * 空值、非数字、超出真实时区范围的都回落到默认值。
 */
export function parseOffsetEnv(raw?: string): number {
  if (raw == null || raw.trim() === "") return DEFAULT_OFFSET_MINUTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_OFFSET_MINUTES;
  const minutes = Math.round(parsed);
  if (minutes < MIN_OFFSET_MINUTES || minutes > MAX_OFFSET_MINUTES) {
    return DEFAULT_OFFSET_MINUTES;
  }
  return minutes;
}

export function formatWithOffset(input: unknown, offsetMinutes: number): string | null {
  if (input == null) return null;
  const date = input instanceof Date ? input : new Date(String(input));
  if (Number.isNaN(date.getTime())) return null;

  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hour = String(shifted.getUTCHours()).padStart(2, "0");
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  const second = String(shifted.getUTCSeconds()).padStart(2, "0");
  const millisecond = String(shifted.getUTCMilliseconds()).padStart(3, "0");

  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}${sign}${hh}:${mm}`;
}

/**
 * 把「本地某一天」换算成 UTC 时间区间，端点为 [start, end)。
 * 日期按 TZ_OFFSET 指定的时区解释，所以 TZ_OFFSET=480 时
 * 2026-08-20 指的是 2026-08-20T00:00+08:00 到 2026-08-21T00:00+08:00。
 * 格式不对或日期不存在（如 2026-02-30）返回 null。
 */
export function localDayRange(
  date: string,
  offsetMinutes: number,
): { start: Date; end: Date } | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!matched) return null;

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);

  const localMidnight = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(localMidnight);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }

  const start = new Date(localMidnight - offsetMinutes * 60_000);
  return { start, end: new Date(start.getTime() + 86400_000) };
}
