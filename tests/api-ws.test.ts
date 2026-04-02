import { describe, test, expect, beforeEach } from "bun:test";
import { NanoClawEvents, parseWsPath, createWsMessage } from "../src/api/ws.ts";

describe("NanoClawEvents", () => {
  let events: NanoClawEvents;

  beforeEach(() => {
    events = new NanoClawEvents();
  });

  test("subscribe and emit delivers message", () => {
    const received: string[] = [];
    const ws = { send: (msg: string) => received.push(msg) };
    events.subscribe("notifications", ws);
    events.emit("notifications", { type: "alert", data: { msg: "test" }, timestamp: "2026-04-01T10:00:00Z" });
    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0]);
    expect(parsed.type).toBe("alert");
    expect(parsed.data.msg).toBe("test");
  });

  test("emit to multiple subscribers", () => {
    const received1: string[] = [];
    const received2: string[] = [];
    events.subscribe("ch", { send: (m) => received1.push(m) });
    events.subscribe("ch", { send: (m) => received2.push(m) });
    events.emit("ch", { type: "ping", timestamp: "" });
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  test("emit to empty channel is a no-op", () => {
    // Should not throw
    events.emit("nonexistent", { type: "ping", timestamp: "" });
  });

  test("unsubscribe removes subscriber", () => {
    const received: string[] = [];
    const ws = { send: (m: string) => received.push(m) };
    events.subscribe("ch", ws);
    events.unsubscribe("ch", ws);
    events.emit("ch", { type: "ping", timestamp: "" });
    expect(received).toHaveLength(0);
  });

  test("unsubscribe cleans up empty channel", () => {
    const ws = { send: () => {} };
    events.subscribe("ch", ws);
    expect(events.getChannelCount()).toBe(1);
    events.unsubscribe("ch", ws);
    expect(events.getChannelCount()).toBe(0);
  });

  test("unsubscribeAll removes from all channels", () => {
    const ws = { send: () => {} };
    events.subscribe("ch1", ws);
    events.subscribe("ch2", ws);
    expect(events.getChannelCount()).toBe(2);
    events.unsubscribeAll(ws);
    expect(events.getChannelCount()).toBe(0);
  });

  test("getSubscriberCount returns correct count", () => {
    const ws1 = { send: () => {} };
    const ws2 = { send: () => {} };
    events.subscribe("ch", ws1);
    events.subscribe("ch", ws2);
    expect(events.getSubscriberCount("ch")).toBe(2);
    expect(events.getSubscriberCount("other")).toBe(0);
  });

  test("send errors are silently caught", () => {
    const ws = {
      send: () => {
        throw new Error("connection closed");
      },
    };
    events.subscribe("ch", ws);
    // Should not throw
    events.emit("ch", { type: "ping", timestamp: "" });
  });

  test("different channels are independent", () => {
    const received1: string[] = [];
    const received2: string[] = [];
    events.subscribe("ch1", { send: (m) => received1.push(m) });
    events.subscribe("ch2", { send: (m) => received2.push(m) });
    events.emit("ch1", { type: "ping", timestamp: "" });
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(0);
  });
});

describe("parseWsPath", () => {
  test("parses session stream path", () => {
    const result = parseWsPath("/api/ws/sessions/abc-123/stream");
    expect(result).toEqual({ channel: "session:abc-123", sessionId: "abc-123" });
  });

  test("parses notifications path", () => {
    const result = parseWsPath("/api/ws/notifications");
    expect(result).toEqual({ channel: "notifications" });
  });

  test("returns null for unknown paths", () => {
    expect(parseWsPath("/api/sessions")).toBeNull();
    expect(parseWsPath("/api/ws/unknown")).toBeNull();
    expect(parseWsPath("/")).toBeNull();
  });
});

describe("createWsMessage", () => {
  test("creates message with timestamp", () => {
    const msg = createWsMessage("alert", { test: true });
    expect(msg.type).toBe("alert");
    expect(msg.data).toEqual({ test: true });
    expect(msg.timestamp).toBeTruthy();
  });

  test("creates message without data", () => {
    const msg = createWsMessage("ping");
    expect(msg.type).toBe("ping");
    expect(msg.data).toBeUndefined();
  });
});
