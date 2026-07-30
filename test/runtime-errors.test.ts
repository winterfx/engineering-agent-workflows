import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/runtime/errors.js";

describe("errorMessage", () => {
  it("includes bounded nested causes and transport error codes", () => {
    const transport = Object.assign(new Error("Connect Timeout Error"), {
      name: "ConnectTimeoutError",
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const failure = new Error("GitHub API GET failed", {
      cause: new TypeError("fetch failed", { cause: transport }),
    });

    expect(errorMessage(failure)).toBe(
      "GitHub API GET failed; cause: TypeError: fetch failed; cause: ConnectTimeoutError [UND_ERR_CONNECT_TIMEOUT]: Connect Timeout Error",
    );
  });
});
