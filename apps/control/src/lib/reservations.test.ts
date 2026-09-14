import { describe, expect, it } from "vitest";

import { sortByExpiry } from "./reservations";

describe("sortByExpiry", () => {
  it("orders ascending by expiresAt, soonest first", () => {
    const items = [
      { id: "a", expiresAt: "2024-06-01T12:00:00.000Z" },
      { id: "b", expiresAt: "2024-06-01T10:00:00.000Z" },
      { id: "c", expiresAt: "2024-06-01T11:00:00.000Z" },
    ];
    expect(sortByExpiry(items).map((item) => item.id)).toStrictEqual(["b", "c", "a"]);
  });

  it("does not mutate the input array", () => {
    const items = [
      { id: "a", expiresAt: "2024-06-01T12:00:00.000Z" },
      { id: "b", expiresAt: "2024-06-01T10:00:00.000Z" },
    ];
    const original = [...items];
    sortByExpiry(items);
    expect(items).toStrictEqual(original);
  });

  it("returns an empty list unchanged", () => {
    expect(sortByExpiry([])).toStrictEqual([]);
  });
});
