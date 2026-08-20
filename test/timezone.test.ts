import { assertEquals } from "@std/assert";
import { DEFAULT_OFFSET_MINUTES, formatWithOffset, parseOffsetEnv } from "../src/lib/timezone.ts";

Deno.test("TZ_OFFSET 按分钟解析", () => {
  assertEquals(parseOffsetEnv("480"), 480); // +08:00
  assertEquals(parseOffsetEnv("-300"), -300); // -05:00
  assertEquals(parseOffsetEnv("0"), 0); // UTC
});

Deno.test("非整点时区能原样表示", () => {
  assertEquals(parseOffsetEnv("330"), 330); // +05:30 印度
  assertEquals(parseOffsetEnv("345"), 345); // +05:45 尼泊尔
  assertEquals(parseOffsetEnv("-210"), -210); // -03:30 纽芬兰
});

Deno.test("没设置、写错、超出真实时区范围的都回落到默认值", () => {
  assertEquals(parseOffsetEnv(undefined), DEFAULT_OFFSET_MINUTES);
  assertEquals(parseOffsetEnv(""), DEFAULT_OFFSET_MINUTES);
  assertEquals(parseOffsetEnv("   "), DEFAULT_OFFSET_MINUTES);
  assertEquals(parseOffsetEnv("east eight"), DEFAULT_OFFSET_MINUTES);
  assertEquals(parseOffsetEnv("841"), DEFAULT_OFFSET_MINUTES);
  assertEquals(parseOffsetEnv("-721"), DEFAULT_OFFSET_MINUTES);
});

Deno.test("时间戳按分钟偏移换算", () => {
  assertEquals(
    formatWithOffset("2026-08-20T00:00:00Z", parseOffsetEnv("480")),
    "2026-08-20T08:00:00.000+08:00",
  );
  assertEquals(
    formatWithOffset("2026-08-20T00:00:00Z", parseOffsetEnv("330")),
    "2026-08-20T05:30:00.000+05:30",
  );
  assertEquals(
    formatWithOffset("2026-08-20T00:00:00Z", parseOffsetEnv("-300")),
    "2026-08-19T19:00:00.000-05:00",
  );
});
