import { describe, expect, it } from "vitest";
import { AppConfigSchema } from "../src/config/schema.js";

describe("scaffold smoke", () => {
  it("exports a zod config schema", () => {
    expect(AppConfigSchema).toBeTypeOf("object");
  });
});
