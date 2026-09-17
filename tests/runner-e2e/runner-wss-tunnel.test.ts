import { describe, expect, it } from "vitest";
import { allowsRunnerUpgrade } from "./runner-wss-tunnel.js";
describe("runner-only test tunnel", () => {
  it("allows only the exact authenticated runner WebSocket route", () => {
    expect(allowsRunnerUpgrade("GET", "/api/runner/v1/connect/1234-abcd")).toBe(true);
    for (const url of ["/", "/api/companies", "/api/instance/settings", "/api/runner/v1/connect/../companies", "/api/runner/v1/connect/a?token=x", "/api/runner/v1/connect/a/", "/api/runner/v1/connect/%2fapi"]) {
      expect(allowsRunnerUpgrade("GET", url)).toBe(false);
    }
    expect(allowsRunnerUpgrade("POST", "/api/runner/v1/connect/a")).toBe(false);
  });
});
