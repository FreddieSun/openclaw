import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { modelsHandlers } from "./models.js";

async function query(cfg: OpenClawConfig, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  await modelsHandlers["models.default"]({
    req: { type: "req", id: "default-model", method: "models.default", params },
    params,
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: { getRuntimeConfig: () => cfg } as never,
  });
  return respond;
}

describe("models.default", () => {
  it.each([
    {
      label: "global inheritance",
      cfg: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      id: "openai/gpt-5.5",
    },
    {
      label: "default agent override",
      cfg: {
        agents: {
          defaults: { model: "openai/gpt-5.5" },
          list: [
            { id: "first" },
            { id: "chosen", default: true, model: { primary: "anthropic/claude-sonnet-4-6" } },
          ],
        },
      },
      id: "anthropic/claude-sonnet-4-6",
    },
    {
      label: "configured alias",
      cfg: {
        agents: {
          defaults: {
            model: "fast",
            models: { "openai/gpt-5.5": { alias: "fast" } },
          },
        },
      },
      id: "openai/gpt-5.5",
    },
  ])("resolves $label through the native resolver", async ({ cfg, id }) => {
    const before = structuredClone(cfg);
    const respond = await query(cfg as OpenClawConfig);
    expect(respond).toHaveBeenCalledWith(true, { id }, undefined);
    expect(cfg).toEqual(before);
  });

  it("rejects session/model overrides rather than reading a conversation", async () => {
    const respond = await query({}, { sessionKey: "existing", model: "override" });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
