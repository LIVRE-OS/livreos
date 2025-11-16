// scripts/github-to-notion.js
// Sync a single GitHub issue to the Notion "Dev Tasks" database.

const fs = require("fs");

// ENV
const notionToken = process.env.NOTION_TOKEN;
const databaseId = process.env.NOTION_DEV_TASKS_DB_ID;
const githubEventPath = process.env.GITHUB_EVENT_PATH;

if (!notionToken || !databaseId || !githubEventPath) {
  console.error(
    "Missing NOTION_TOKEN, NOTION_DEV_TASKS_DB_ID, or GITHUB_EVENT_PATH env vars"
  );
  process.exit(1);
}

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// ---------- Notion helpers ----------

async function notionFetch(path, options = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Notion API error:", text);
    throw new Error(`Notion request failed: ${res.status}`);
  }

  return res.json();
}

function getTitleFromIssue(issue) {
  return issue.title || "Untitled issue";
}

// Map GitHub Issue → Notion Status
function mapGithubToNotionStatus(issue) {
  const state = issue.state; // "open" or "closed"
  const labels = issue.labels || [];

  // Find first "status/..." label, if any
  let statusLabel = null;
  for (const label of labels) {
    if (label.name && label.name.startsWith("status/")) {
      statusLabel = label.name.slice("status/".length); // e.g. "in-progress"
      break;
    }
  }

  // If issue is closed → Done or Archived
  if (state === "closed") {
    if (statusLabel === "archived") return "Archived";
    return "Done";
  }

  // Issue is open → map by status label
  switch (statusLabel) {
    case "ready":
      return "Ready";
    case "in-progress":
      return "In Progress";
    case "blocked":
      return "Blocked";
    case "review":
      return "Review";
    case "backlog":
    default:
      return "Backlog";
  }
}

async function findTaskByIssueNumber(issueNumber) {
  const body = {
    filter: {
      property: "GitHub Issue ID",
      number: { equals: issueNumber },
    },
    page_size: 1,
  };

  const data = await notionFetch(`/databases/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return (data.results && data.results[0]) || null;
}

async function createTaskFromIssue(issue) {
  const title = getTitleFromIssue(issue);
  const status = mapGithubToNotionStatus(issue);

  const body = {
    parent: { database_id: databaseId },
    properties: {
      Name: {
        title: [{ type: "text", text: { content: title } }],
      },
      Status: {
        select: { name: status },
      },
      "GitHub Issue ID": {
        number: issue.number,
      },
      "GitHub URL": {
        url: issue.html_url,
      },
      Source: {
        select: { name: "GitHub" },
      },
      "Last Synced": {
        date: { start: new Date().toISOString() },
      },
    },
  };

  await notionFetch(`/pages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function updateTaskFromIssue(pageId, issue) {
  const title = getTitleFromIssue(issue);
  const status = mapGithubToNotionStatus(issue);

  const body = {
    properties: {
      Name: {
        title: [{ type: "text", text: { content: title } }],
      },
      Status: {
        select: { name: status },
      },
      "GitHub URL": {
        url: issue.html_url,
      },
      Source: {
        select: { name: "GitHub" },
      },
      "Last Synced": {
        date: { start: new Date().toISOString() },
      },
    },
  };

  await notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---------- Main ----------

(async () => {
  try {
    const raw = fs.readFileSync(githubEventPath, "utf8");
    const event = JSON.parse(raw);

    const issue = event.issue;
    if (!issue) {
      console.log("No issue in event payload. Nothing to sync.");
      return;
    }

    console.log(`Syncing GitHub issue #${issue.number} → Notion...`);

    const existing = await findTaskByIssueNumber(issue.number);

    if (existing) {
      console.log("Existing Notion task found. Updating...");
      await updateTaskFromIssue(existing.id, issue);
    } else {
      console.log("No Notion task found. Creating...");
      await createTaskFromIssue(issue);
    }

    console.log("GitHub → Notion sync complete.");
  } catch (err) {
    console.error("Sync error:", err);
    process.exit(1);
  }
})();
