import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DIR = import.meta.dirname;
const ENV_PATH = resolve(DIR, ".env");
const TOKENS_PATH = resolve(DIR, ".tokens.json");
const TIMELY_BASE = "https://api.timelyapp.com/1.1";

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

function loadTokens(): { access_token: string; refresh_token: string; created_at: number } {
  if (!existsSync(TOKENS_PATH)) {
    throw new Error("No .tokens.json found. Run: bun auth.ts");
  }
  return JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
}

async function refreshToken(): Promise<string> {
  const env = loadEnv();
  const tokens = loadTokens();

  const res = await fetch("https://api.timelyapp.com/1.1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: env.TIMELY_CLIENT_ID,
      client_secret: env.TIMELY_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${await res.text()}`);
  }

  const newTokens = await res.json();
  writeFileSync(TOKENS_PATH, JSON.stringify(newTokens, null, 2));
  return newTokens.access_token;
}

let accessToken = loadTokens().access_token;
const env = loadEnv();
const ACCOUNT_ID = env.TIMELY_ACCOUNT_ID;

if (!ACCOUNT_ID) {
  throw new Error("Missing TIMELY_ACCOUNT_ID in .env. Run: bun auth.ts");
}

async function api(
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const url = `${TIMELY_BASE}/${ACCOUNT_ID}${path}`;
  let res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  // Auto-refresh on 401
  if (res.status === 401) {
    accessToken = await refreshToken();
    res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Timely API ${res.status}: ${body}`);
  }

  return res.json();
}

// The authenticated user's ID, resolved once and cached for the process lifetime.
let currentUserId: number | undefined;

async function getCurrentUserId(): Promise<number> {
  if (currentUserId === undefined) {
    const user = (await api("/users/current")) as { id: number };
    currentUserId = user.id;
  }
  return currentUserId;
}

const server = new McpServer({
  name: "timely",
  version: "1.0.0",
});

// Current user
server.tool(
  "timely_me",
  "Get current Timely user info.",
  {},
  async () => {
    const data = await api("/users/current");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// List projects
server.tool(
  "timely_list_projects",
  "List all projects in the Timely account.",
  {},
  async () => {
    const data = await api("/projects");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Get project
server.tool(
  "timely_get_project",
  "Get a single Timely project by ID.",
  {
    project_id: z.number().describe("The project ID"),
  },
  async ({ project_id }) => {
    const data = await api(`/projects/${project_id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// List users
server.tool(
  "timely_list_users",
  "List all users/people in the Timely account.",
  {},
  async () => {
    const data = await api("/users");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Get user
server.tool(
  "timely_get_user",
  "Get a single Timely user by ID.",
  {
    user_id: z.number().describe("The user ID"),
  },
  async ({ user_id }) => {
    const data = await api(`/users/${user_id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// List events (time entries)
server.tool(
  "timely_list_events",
  "List time entries. Defaults to today and to your own entries. For admins, the account-wide view returns every user's entries, so this defaults user_id to the authenticated user. Pass user_id to target another person, or all_users:true for the whole account.",
  {
    since: z.string().optional().describe("Start date YYYY-MM-DD"),
    upto: z.string().optional().describe("End date YYYY-MM-DD"),
    user_id: z.number().optional().describe("Filter by user ID. Defaults to the authenticated user when omitted."),
    project_id: z.number().optional().describe("Filter by project ID"),
    all_users: z.boolean().optional().describe("Admins only: return entries for every user in the account instead of just one. Overrides user_id."),
  },
  async ({ since, upto, user_id, project_id, all_users }) => {
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (upto) params.set("upto", upto);
    const effectiveUserId = all_users ? undefined : user_id ?? (await getCurrentUserId());
    if (effectiveUserId !== undefined) params.set("user_id", String(effectiveUserId));
    if (project_id) params.set("project_id", String(project_id));
    const query = params.toString();
    const data = await api(`/events${query ? `?${query}` : ""}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Get single event
server.tool(
  "timely_get_event",
  "Get a single time entry by ID.",
  {
    event_id: z.number().describe("The event/time entry ID"),
  },
  async ({ event_id }) => {
    const data = await api(`/events/${event_id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Create event (time entry)
server.tool(
  "timely_create_event",
  "Create a new time entry in Timely.",
  {
    project_id: z.number().describe("Project ID to log time to"),
    day: z.string().describe("Date in YYYY-MM-DD format"),
    hours: z.number().describe("Duration hours (0-12)"),
    minutes: z.number().optional().describe("Duration minutes (0-59)"),
    note: z.string().optional().describe("Description of work done"),
    from: z.string().optional().describe("Start time ISO 8601, e.g. 2026-03-06T09:00:00+02:00"),
    to: z.string().optional().describe("End time ISO 8601, e.g. 2026-03-06T11:00:00+02:00"),
    label_ids: z.array(z.number()).optional().describe("Array of label/tag IDs to attach"),
  },
  async ({ project_id, day, hours, minutes, note, from, to, label_ids }) => {
    const event: Record<string, unknown> = { day, hours, project_id };
    if (minutes !== undefined) event.minutes = minutes;
    if (note) event.note = note;
    if (from) event.from = from;
    if (to) event.to = to;
    if (label_ids) event.label_ids = label_ids;
    const data = await api("/events", {
      method: "POST",
      body: JSON.stringify({ event }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Update event
server.tool(
  "timely_update_event",
  "Update an existing time entry.",
  {
    event_id: z.number().describe("The event/time entry ID"),
    project_id: z.number().optional().describe("New project ID"),
    day: z.string().optional().describe("New date YYYY-MM-DD"),
    hours: z.number().optional().describe("New duration hours"),
    minutes: z.number().optional().describe("New duration minutes"),
    note: z.string().optional().describe("New description"),
    from: z.string().optional().describe("New start time ISO 8601"),
    to: z.string().optional().describe("New end time ISO 8601"),
    label_ids: z.array(z.number()).optional().describe("New array of label/tag IDs"),
  },
  async ({ event_id, ...fields }) => {
    const event: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) event[k] = v;
    }
    const data = await api(`/events/${event_id}`, {
      method: "PUT",
      body: JSON.stringify({ event }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Delete event
server.tool(
  "timely_delete_event",
  "Delete a time entry.",
  {
    event_id: z.number().describe("The event/time entry ID to delete"),
  },
  async ({ event_id }) => {
    await api(`/events/${event_id}`, { method: "DELETE" });
    return { content: [{ type: "text" as const, text: `Deleted event ${event_id}` }] };
  }
);

// List labels
server.tool(
  "timely_list_labels",
  "List all labels/tags in the Timely account.",
  {},
  async () => {
    const data = await api("/labels");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Get label
server.tool(
  "timely_get_label",
  "Get a single label by ID, including child labels.",
  {
    label_id: z.number().describe("The label ID"),
  },
  async ({ label_id }) => {
    const data = await api(`/labels/${label_id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// List tasks (forecasts)
server.tool(
  "timely_list_tasks",
  "List all tasks/forecasts in the account.",
  {},
  async () => {
    const data = await api("/forecasts");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

// Get task
server.tool(
  "timely_get_task",
  "Get a single task/forecast by ID.",
  {
    task_id: z.number().describe("The task/forecast ID"),
  },
  async ({ task_id }) => {
    const data = await api(`/forecasts/${task_id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
