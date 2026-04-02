import { describe, test, expect } from "bun:test";
import { matchesCron, nextCronTime } from "../src/fleet/cron.ts";

describe("matchesCron", () => {
  test("matches daily at 8pm", () => {
    expect(matchesCron("0 20 * * *", new Date("2026-04-02T20:00:00"))).toBe(true);
  });

  test("does not match wrong minute", () => {
    expect(matchesCron("0 20 * * *", new Date("2026-04-02T19:59:00"))).toBe(false);
  });

  test("does not match wrong hour", () => {
    expect(matchesCron("0 20 * * *", new Date("2026-04-02T21:00:00"))).toBe(false);
  });

  test("matches every 5 minutes", () => {
    expect(matchesCron("*/5 * * * *", new Date("2026-04-02T12:15:00"))).toBe(true);
    expect(matchesCron("*/5 * * * *", new Date("2026-04-02T12:00:00"))).toBe(true);
    expect(matchesCron("*/5 * * * *", new Date("2026-04-02T12:05:00"))).toBe(true);
  });

  test("does not match non-step minute", () => {
    expect(matchesCron("*/5 * * * *", new Date("2026-04-02T12:13:00"))).toBe(false);
  });

  test("matches specific day of week (Monday at 9am)", () => {
    // 2026-04-06 is a Monday
    expect(matchesCron("0 9 * * 1", new Date("2026-04-06T09:00:00"))).toBe(true);
  });

  test("does not match wrong day of week", () => {
    // 2026-04-07 is a Tuesday
    expect(matchesCron("0 9 * * 1", new Date("2026-04-07T09:00:00"))).toBe(false);
  });

  test("matches comma list", () => {
    expect(matchesCron("0,30 * * * *", new Date("2026-04-02T12:00:00"))).toBe(true);
    expect(matchesCron("0,30 * * * *", new Date("2026-04-02T12:30:00"))).toBe(true);
    expect(matchesCron("0,30 * * * *", new Date("2026-04-02T12:15:00"))).toBe(false);
  });

  test("matches range", () => {
    expect(matchesCron("* 9-17 * * *", new Date("2026-04-02T09:00:00"))).toBe(true);
    expect(matchesCron("* 9-17 * * *", new Date("2026-04-02T17:00:00"))).toBe(true);
    expect(matchesCron("* 9-17 * * *", new Date("2026-04-02T08:00:00"))).toBe(false);
    expect(matchesCron("* 9-17 * * *", new Date("2026-04-02T18:00:00"))).toBe(false);
  });

  test("matches range with step", () => {
    // 1-10/3 = 1, 4, 7, 10
    expect(matchesCron("1-10/3 * * * *", new Date("2026-04-02T12:01:00"))).toBe(true);
    expect(matchesCron("1-10/3 * * * *", new Date("2026-04-02T12:04:00"))).toBe(true);
    expect(matchesCron("1-10/3 * * * *", new Date("2026-04-02T12:07:00"))).toBe(true);
    expect(matchesCron("1-10/3 * * * *", new Date("2026-04-02T12:10:00"))).toBe(true);
    expect(matchesCron("1-10/3 * * * *", new Date("2026-04-02T12:02:00"))).toBe(false);
    expect(matchesCron("1-10/3 * * * *", new Date("2026-04-02T12:11:00"))).toBe(false);
  });

  test("matches specific day of month", () => {
    expect(matchesCron("0 0 15 * *", new Date("2026-04-15T00:00:00"))).toBe(true);
    expect(matchesCron("0 0 15 * *", new Date("2026-04-14T00:00:00"))).toBe(false);
  });

  test("matches specific month", () => {
    expect(matchesCron("0 0 1 1 *", new Date("2026-01-01T00:00:00"))).toBe(true);
    expect(matchesCron("0 0 1 1 *", new Date("2026-02-01T00:00:00"))).toBe(false);
  });

  test("matches all wildcards (every minute)", () => {
    expect(matchesCron("* * * * *", new Date("2026-04-02T15:42:00"))).toBe(true);
  });

  test("Sunday is 0", () => {
    // 2026-04-05 is a Sunday
    expect(matchesCron("* * * * 0", new Date("2026-04-05T12:00:00"))).toBe(true);
    expect(matchesCron("* * * * 0", new Date("2026-04-06T12:00:00"))).toBe(false);
  });

  test("throws on invalid expression", () => {
    expect(() => matchesCron("* * *", new Date())).toThrow("5 fields");
  });
});

describe("nextCronTime", () => {
  test("finds next daily 8pm", () => {
    const after = new Date("2026-04-02T20:01:00");
    const next = nextCronTime("0 20 * * *", after);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(3); // April
    expect(next.getDate()).toBe(3);
    expect(next.getHours()).toBe(20);
    expect(next.getMinutes()).toBe(0);
  });

  test("finds next from before matching time", () => {
    const after = new Date("2026-04-02T19:00:00");
    const next = nextCronTime("0 20 * * *", after);
    expect(next.getDate()).toBe(2);
    expect(next.getHours()).toBe(20);
  });

  test("finds next for every-5-minutes", () => {
    const after = new Date("2026-04-02T12:13:00");
    const next = nextCronTime("*/5 * * * *", after);
    expect(next.getMinutes()).toBe(15);
  });

  test("finds next Monday", () => {
    // 2026-04-02 is Thursday
    const after = new Date("2026-04-02T10:00:00");
    const next = nextCronTime("0 9 * * 1", after);
    expect(next.getDate()).toBe(6); // Next Monday
    expect(next.getHours()).toBe(9);
  });

  test("finds next occurrence of specific day of month", () => {
    const after = new Date("2026-04-16T00:00:00");
    const next = nextCronTime("0 0 15 * *", after);
    expect(next.getMonth()).toBe(4); // May (0-indexed)
    expect(next.getDate()).toBe(15);
  });
});
