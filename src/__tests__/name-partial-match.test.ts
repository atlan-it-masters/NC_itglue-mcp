import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { ITGlueClient, normalizeForFuzzyNameMatch, createMcpServer } from "../mcp-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const emptyMeta = { currentPage: 1, nextPage: null, prevPage: null, totalPages: 1, totalCount: 0 };

function jsonApi(data: Array<Record<string, unknown>>) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        data,
        meta: {
          "current-page": 1,
          "next-page": null,
          "prev-page": null,
          "total-pages": 1,
          "total-count": data.length,
        },
      }),
    text: () => Promise.resolve(""),
  });
}

// IT Glue's API does exact-match on filter[name]; the fork adds a client-side
// partial-match fallback. Upstream repeatedly edits these same handler lines,
// so these tests guard the CALL SITES, not just the client method — resolving a
// future merge conflict the wrong way would otherwise pass every other test.
describe("search_* handlers use the partial-name fallback", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  async function connect(): Promise<Client> {
    const server = createMcpServer({ apiKey: "test-api-key" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "partial-match-test", version: "1.0.0" });
    await client.connect(ct);
    return client;
  }

  function firstText(result: unknown): string {
    return (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
  }

  const cases: Array<{ tool: string; type: string; extra?: Record<string, unknown> }> = [
    { tool: "search_organizations", type: "organizations" },
    { tool: "search_configurations", type: "configurations" },
    { tool: "search_locations", type: "locations" },
    { tool: "search_passwords", type: "passwords" },
    { tool: "search_flexible_assets", type: "flexible-assets", extra: { flexible_asset_type_id: 1 } },
  ];

  for (const { tool, type, extra } of cases) {
    it(`${tool} finds "Gebrema B.V." when searching "Gebrema"`, async () => {
      const client = await connect();
      mockFetch.mockReturnValueOnce(jsonApi([])); // exact filter[name] misses
      mockFetch.mockReturnValueOnce(
        jsonApi([
          { id: "1", type, attributes: { name: "Gebrema B.V." } },
          { id: "2", type, attributes: { name: "Other Corp" } },
        ])
      );

      const result = await client.callTool({
        name: tool,
        arguments: { name: "Gebrema", ...(extra ?? {}) },
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(firstText(result)).toContain("Gebrema B.V.");
      expect(firstText(result)).not.toContain("Other Corp");
    });
  }
});

describe("requestWithNamePartialMatch", () => {
  function clientWith(pages: Array<Array<{ name?: unknown }>>) {
    const client = new ITGlueClient({ apiKey: "test-key", region: "eu" });
    const request = vi
      .fn()
      .mockImplementation(() => Promise.resolve({ data: pages.shift() ?? [], meta: { ...emptyMeta } }));
    (client as unknown as { request: unknown }).request = request;
    return { client, request };
  }

  it("treats 'BV' and 'B.V.' as equivalent", async () => {
    const { client } = clientWith([[], [{ name: "Gebrema B.V." }]]);
    const res = await client.requestWithNamePartialMatch<{ name?: unknown }>(
      "/organizations",
      { filter: { name: "Gebrema BV" }, page: { size: 50, number: 1 } },
      "Gebrema BV"
    );
    expect(res.data).toEqual([{ name: "Gebrema B.V." }]);
  });

  it("does not fall back when the exact filter already matched", async () => {
    const { client, request } = clientWith([[{ name: "Gebrema B.V." }]]);
    await client.requestWithNamePartialMatch<{ name?: unknown }>(
      "/organizations",
      { filter: { name: "Gebrema B.V." }, page: { size: 50, number: 1 } },
      "Gebrema B.V."
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns no false positives for a genuinely absent org", async () => {
    const { client } = clientWith([[], [{ name: "Gebrema B.V." }, { name: "Other Corp" }]]);
    const res = await client.requestWithNamePartialMatch<{ name?: unknown }>(
      "/organizations",
      { filter: { name: "Nonexistent Ltd" }, page: { size: 50, number: 1 } },
      "Nonexistent Ltd"
    );
    expect(res.data).toEqual([]);
  });

  it("drops the name filter on the fallback fetch but keeps other filters", async () => {
    const { client, request } = clientWith([[], [{ name: "Gebrema B.V." }]]);
    await client.requestWithNamePartialMatch<{ name?: unknown }>(
      "/organizations",
      { filter: { name: "Gebrema", organizationStatusId: 42 }, page: { size: 50, number: 1 } },
      "Gebrema"
    );
    expect(request.mock.calls[1][1].filter).toEqual({ organizationStatusId: 42 });
  });
});

describe("normalizeForFuzzyNameMatch", () => {
  it("is case-insensitive and strips periods", () => {
    expect(normalizeForFuzzyNameMatch("Gebrema B.V.")).toBe(normalizeForFuzzyNameMatch("gebrema bv"));
  });
});
