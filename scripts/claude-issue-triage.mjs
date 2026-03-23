#!/usr/bin/env node
// @ts-check

/**
 * Claude-powered issue triage script.
 *
 * Uses the Anthropic Messages API to classify a GitHub issue and return
 * suggested labels plus an optional summary comment.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  – Anthropic API key (required)
 *   GITHUB_TOKEN       – GitHub token for API operations (required in CI)
 *   GITHUB_REPOSITORY  – owner/repo (set automatically by Actions)
 *   ISSUE_NUMBER       – issue number to triage
 *   ISSUE_TITLE        – issue title
 *   ISSUE_BODY         – issue body text
 *   DRY_RUN            – when "true", print actions without applying them
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6-20250514";
const MAX_BODY_CHARS = 6000;

// Labels the triage model is allowed to suggest (must exist or be auto-created).
const KNOWN_LABELS = [
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

// ── Anthropic API call ─────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} params.issueTitle
 * @param {string} params.issueBody
 * @returns {Promise<{labels: string[], comment: string}>}
 */
export async function triageWithClaude({ apiKey, issueTitle, issueBody }) {
  const truncatedBody =
    issueBody.length > MAX_BODY_CHARS
      ? `${issueBody.slice(0, MAX_BODY_CHARS)}…[truncated]`
      : issueBody;

  const systemPrompt = `You are an expert open-source issue triager for OpenClaw, a personal AI assistant platform.
Classify the GitHub issue below and respond with ONLY a valid JSON object (no markdown fences).

Available labels: ${JSON.stringify(KNOWN_LABELS)}

Rules:
- "bug" = something is broken or crashes.
- "enhancement" = feature request or improvement.
- "question" = the user is asking for help or clarification.
- "documentation" = docs improvement or docs bug.
- "gateway" = relates to the gateway server.
- "cli" = relates to the CLI tool.
- "agents" = relates to AI agent behavior or model providers.
- "security" = security concern or vulnerability.
- "good first issue" = simple, well-scoped fix suitable for newcomers.
- "needs-info" = the issue lacks enough detail to act on.

Pick 1-3 labels. Write a short (2-3 sentence) summary comment that acknowledges the issue and may suggest next steps.

Respond with this exact JSON shape:
{"labels": ["label1"], "comment": "Your summary here."}`;

  const userMessage = `Issue title: ${issueTitle}\n\nIssue body:\n${truncatedBody}`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text ?? "";

  return parseTriageResponse(text);
}

// ── Response parsing ────────────────────────────────────────────────────────

/**
 * Parse and validate the JSON response from Claude.
 * @param {string} raw
 * @returns {{labels: string[], comment: string}}
 */
export function parseTriageResponse(raw) {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse Claude response as JSON: ${cleaned}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Claude response is not an object");
  }

  const labels = Array.isArray(parsed.labels)
    ? parsed.labels.filter(
        (/** @type {unknown} */ l) => typeof l === "string" && KNOWN_LABELS.includes(l),
      )
    : [];

  const comment = typeof parsed.comment === "string" ? parsed.comment.trim() : "";

  if (labels.length === 0) {
    throw new Error(`No valid labels in Claude response: ${JSON.stringify(parsed)}`);
  }

  return { labels, comment };
}

// ── GitHub API helpers ──────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string} params.token
 * @param {string} params.repo    - "owner/repo"
 * @param {number} params.issueNumber
 * @param {string[]} params.labels
 */
async function addLabels({ token, repo, issueNumber, labels }) {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ labels }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub addLabels failed (${res.status}): ${body}`);
  }
}

/**
 * @param {object} params
 * @param {string} params.token
 * @param {string} params.repo
 * @param {number} params.issueNumber
 * @param {string} params.body
 */
async function addComment({ token, repo, issueNumber, body }) {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`GitHub addComment failed (${res.status}): ${bodyText}`);
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Skipping Claude issue triage.");
    process.exit(0);
  }

  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const issueNumber = Number(process.env.ISSUE_NUMBER ?? "0");
  const issueTitle = process.env.ISSUE_TITLE ?? "";
  const issueBody = process.env.ISSUE_BODY ?? "";
  const dryRun = process.env.DRY_RUN === "true";

  if (!issueTitle) {
    console.error("ISSUE_TITLE is empty. Nothing to triage.");
    process.exit(0);
  }

  console.log(`Triaging issue #${issueNumber}: ${issueTitle}`);

  const { labels, comment } = await triageWithClaude({
    apiKey,
    issueTitle,
    issueBody,
  });

  console.log(`Suggested labels: ${labels.join(", ")}`);
  if (comment) {
    console.log(`Summary: ${comment}`);
  }

  if (dryRun) {
    console.log("DRY_RUN=true – skipping GitHub API calls.");
    console.log(JSON.stringify({ labels, comment }, null, 2));
    process.exit(0);
  }

  if (!githubToken || !repo || !issueNumber) {
    console.error(
      "Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or ISSUE_NUMBER – cannot apply labels.",
    );
    process.exit(1);
  }

  await addLabels({ token: githubToken, repo, issueNumber, labels });
  console.log(`Applied labels: ${labels.join(", ")}`);

  if (comment) {
    const triageComment = `🤖 **Claude Triage Summary**\n\n${comment}\n\n---\n<sub>Auto-triaged by Claude • Labels: ${labels.map((l) => `\`${l}\``).join(", ")}</sub>`;
    await addComment({
      token: githubToken,
      repo,
      issueNumber,
      body: triageComment,
    });
    console.log("Posted triage comment.");
  }

  console.log("Issue triage complete.");
}

// Only run main when executed directly (not when imported for testing)
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("claude-issue-triage.mjs") ||
    process.argv[1].includes("claude-issue-triage"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("Triage failed:", err.message ?? err);
    process.exit(1);
  });
}
