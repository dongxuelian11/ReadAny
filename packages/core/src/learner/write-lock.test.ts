import { describe, expect, it } from "vitest";
import { withLearnerWriteLock } from "./write-lock";

describe("learner write lock", () => {
  it("serializes overlapping operations (second starts only after first settles)", async () => {
    const trace: string[] = [];
    const first = withLearnerWriteLock(async () => {
      trace.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      trace.push("first:end");
    });
    const second = withLearnerWriteLock(async () => {
      trace.push("second:start");
    });
    await Promise.all([first, second]);
    expect(trace).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("preserves the held operation's return value", async () => {
    const value = await withLearnerWriteLock(async () => 42);
    expect(value).toBe(42);
  });

  it("lets a later caller run after a failing holder (the lock never wedges)", async () => {
    await expect(
      withLearnerWriteLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const result = await withLearnerWriteLock(async () => "recovered");
    expect(result).toBe("recovered");
  });
});
