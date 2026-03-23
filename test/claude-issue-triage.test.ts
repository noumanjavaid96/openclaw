import { beforeAll, describe, expect, it } from "vitest";

let parseTriageResponse: (raw: string) => { labels: string[]; comment: string };

beforeAll(async () => {
  const mod = await import("../scripts/claude-issue-triage.mjs");
  parseTriageResponse = mod.parseTriageResponse;
});

describe("parseTriageResponse", () => {
  it("parses valid JSON with known labels", () => {
    const raw = JSON.stringify({
      labels: ["bug", "cli"],
      comment: "This looks like a CLI crash.",
    });
    const result = parseTriageResponse(raw);
    expect(result.labels).toEqual(["bug", "cli"]);
    expect(result.comment).toBe("This looks like a CLI crash.");
  });

  it("strips markdown code fences", () => {
    const raw = `\`\`\`json
{"labels": ["enhancement"], "comment": "Feature request for voice support."}
\`\`\``;
    const result = parseTriageResponse(raw);
    expect(result.labels).toEqual(["enhancement"]);
    expect(result.comment).toBe("Feature request for voice support.");
  });

  it("filters out unknown labels", () => {
    const raw = JSON.stringify({
      labels: ["bug", "unknown-label", "cli"],
      comment: "Bug in CLI.",
    });
    const result = parseTriageResponse(raw);
    expect(result.labels).toEqual(["bug", "cli"]);
  });

  it("throws when no valid labels remain", () => {
    const raw = JSON.stringify({
      labels: ["made-up"],
      comment: "Some comment.",
    });
    expect(() => parseTriageResponse(raw)).toThrow(/No valid labels/);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseTriageResponse("not json at all")).toThrow(/Failed to parse/);
  });

  it("throws when response is not an object", () => {
    expect(() => parseTriageResponse('"just a string"')).toThrow(/not an object/);
  });

  it("handles missing comment gracefully", () => {
    const raw = JSON.stringify({ labels: ["question"] });
    const result = parseTriageResponse(raw);
    expect(result.labels).toEqual(["question"]);
    expect(result.comment).toBe("");
  });

  it("trims whitespace from comment", () => {
    const raw = JSON.stringify({
      labels: ["documentation"],
      comment: "  Docs update needed.  ",
    });
    const result = parseTriageResponse(raw);
    expect(result.comment).toBe("Docs update needed.");
  });

  it("accepts all known label types", () => {
    const allLabels = [
      "bug",
      "enhancement",
      "question",
      "documentation",
      "gateway",
      "cli",
      "agents",
      "security",
      "good first issue",
      "needs-info",
    ];
    const raw = JSON.stringify({
      labels: allLabels,
      comment: "All labels test.",
    });
    const result = parseTriageResponse(raw);
    expect(result.labels).toEqual(allLabels);
  });
});
