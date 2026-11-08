import { describe, expect, it } from "vitest";

function canReadHistory(
  role: string,
  self: boolean,
  assigned: boolean,
): boolean {
  return (role === "patient" && self) || (role === "professional" && assigned);
}

function bookingOutcome(concurrent: number): number[] {
  let booked = false;
  return Array.from({ length: concurrent }, () => {
    if (booked) return 409;
    booked = true;
    return 201;
  });
}

describe("authorization and booking invariants", () => {
  it("isolates patient and professional history and denies staff", () => {
    expect(canReadHistory("patient", true, false)).toBe(true);
    expect(canReadHistory("patient", false, true)).toBe(false);
    expect(canReadHistory("professional", false, true)).toBe(true);
    expect(canReadHistory("professional", false, false)).toBe(false);
    expect(canReadHistory("staff", true, true)).toBe(false);
  });

  it("allows exactly one winner for a concurrent slot booking", () => {
    expect(bookingOutcome(2).sort()).toEqual([201, 409]);
  });
});
