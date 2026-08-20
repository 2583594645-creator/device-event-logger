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
