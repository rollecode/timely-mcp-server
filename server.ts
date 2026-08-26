import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { api } from "./timely.ts";

const VERSION = "2.0.0";
const DEFAULT_PORT = 8450;
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? "").replace(/\/$/, "");
const ICON_SIZES = [48, 96, 256];

function buildServer(): McpServer {
  const server = new McpServer(
  {
    name: "timely",
    version: VERSION,
    ...(PUBLIC_URL
      ? {
          websiteUrl: PUBLIC_URL,
          icons: ICON_SIZES.map((size) => ({
            src: size === 256 ? `${PUBLIC_URL}/icon.png` : `${PUBLIC_URL}/icon-${size}.png`,
            mimeType: "image/png",
            sizes: [`${size}x${size}`],
          })),
        }
      : {}),
  },
  {
    instructions:
      "Read and write Timely time tracking: log and edit hours, browse projects, " +
      "clients, users, labels and teams, run reports, and manage planned work. " +
      "Use timely_list_projects to find a project_id, then timely_create_event to " +
      "log time. timely_report is the one to reach for when summarising a period.",
  },
);

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE = { ...WRITE, destructiveHint: true };

/** Drop keys the caller left unset, so a patch never blanks a field. */
function present(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

// ---------------------------------------------------------------------------
// Account and people
// ---------------------------------------------------------------------------

server.tool("timely_me", "The signed-in user and the accounts they can reach.", {}, READ_ONLY, async () =>
  text(await api("").catch(() => api(""))),
);

server.tool("timely_account", "Account settings: name, currency, week start, capacity.", {}, READ_ONLY, async () =>
  text(await api("")),
);

server.tool(
  "timely_list_users",
  "Everyone on the account, with their rates, capacity and role.",
  { limit: z.number().optional().describe("Maximum users to return.") },
  READ_ONLY,
  async ({ limit }) => text(await api("/users", { query: { limit } })),
);

server.tool(
  "timely_get_user",
  "One user in full.",
  { user_id: z.number().describe("User id from timely_list_users.") },
  READ_ONLY,
  async ({ user_id }) => text(await api(`/users/${user_id}`)),
);

server.tool("timely_list_teams", "Teams and their members.", {}, READ_ONLY, async () => text(await api("/teams")));

server.tool(
  "timely_list_roles",
  "Roles available on the account and what each may do.",
  {},
  READ_ONLY,
  async () => text(await api("/roles")),
);

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

server.tool("timely_list_clients", "Every client, active and archived.", {}, READ_ONLY, async () =>
  text(await api("/clients")),
);

server.tool(
  "timely_get_client",
  "One client in full.",
  { client_id: z.number().describe("Client id from timely_list_clients.") },
  READ_ONLY,
  async ({ client_id }) => text(await api(`/clients/${client_id}`)),
);

server.tool(
  "timely_create_client",
  "Create a client.",
  {
    name: z.string().describe("Client name."),
    external_id: z.string().optional().describe("Your own reference, e.g. a CRM id."),
  },
  WRITE,
  async ({ name, external_id }) =>
    text(await api("/clients", { method: "POST", body: { client: present({ name, external_id }) } })),
);

server.tool(
  "timely_update_client",
  "Rename a client or change its reference. Only what you pass changes.",
  {
    client_id: z.number().describe("Client to update."),
    name: z.string().optional().describe("New name."),
    external_id: z.string().optional().describe("New external reference."),
    active: z.boolean().optional().describe("False archives the client."),
  },
  WRITE,
  async ({ client_id, ...fields }) =>
    text(await api(`/clients/${client_id}`, { method: "PUT", body: { client: present(fields) } })),
);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

server.tool(
  "timely_list_projects",
  "Every project, with its client, budget and hourly rate.",
  { limit: z.number().optional().describe("Maximum projects to return.") },
  READ_ONLY,
  async ({ limit }) => text(await api("/projects", { query: { limit } })),
);

server.tool(
  "timely_get_project",
  "One project in full, including its labels and members.",
  { project_id: z.number().describe("Project id from timely_list_projects.") },
  READ_ONLY,
  async ({ project_id }) => text(await api(`/projects/${project_id}`)),
);

server.tool(
  "timely_create_project",
  "Create a project under a client.",
  {
    name: z.string().describe("Project name."),
    client_id: z.number().describe("Client the project belongs to."),
    color: z.string().optional().describe("Hex colour without the hash, e.g. A020F0."),
    budget: z.number().optional().describe("Budget in hours or currency, per budget_type."),
    budget_type: z.string().optional().describe("One of hours, fees, or blank for none."),
    hourly_rate: z.number().optional().describe("Rate in the account currency."),
    billable: z.boolean().optional().describe("Whether time logged is billable."),
  },
  WRITE,
  async (fields) => text(await api("/projects", { method: "POST", body: { project: present(fields) } })),
);

server.tool(
  "timely_update_project",
  "Change a project. Only what you pass changes.",
  {
    project_id: z.number().describe("Project to update."),
    name: z.string().optional().describe("New name."),
    client_id: z.number().optional().describe("Move to another client."),
    color: z.string().optional().describe("Hex colour without the hash."),
    budget: z.number().optional().describe("New budget."),
    budget_type: z.string().optional().describe("One of hours, fees, or blank."),
    hourly_rate: z.number().optional().describe("New rate."),
    billable: z.boolean().optional().describe("Whether time logged is billable."),
    active: z.boolean().optional().describe("False archives the project."),
  },
  WRITE,
  async ({ project_id, ...fields }) =>
    text(await api(`/projects/${project_id}`, { method: "PUT", body: { project: present(fields) } })),
);

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

server.tool("timely_list_labels", "Labels and their nesting.", {}, READ_ONLY, async () => text(await api("/labels")));

server.tool(
  "timely_get_label",
  "One label in full.",
  { label_id: z.number().describe("Label id from timely_list_labels.") },
  READ_ONLY,
  async ({ label_id }) => text(await api(`/labels/${label_id}`)),
);

server.tool(
  "timely_create_label",
  "Create a label, optionally nested under another.",
  {
    name: z.string().describe("Label name."),
    parent_id: z.number().optional().describe("Parent label to nest under."),
    emoji: z.string().optional().describe("Emoji shown beside the label."),
  },
  WRITE,
  async (fields) => text(await api("/labels", { method: "POST", body: { label: present(fields) } })),
);

server.tool(
  "timely_update_label",
  "Rename or re-nest a label. Only what you pass changes.",
  {
    label_id: z.number().describe("Label to update."),
    name: z.string().optional().describe("New name."),
    parent_id: z.number().optional().describe("New parent label."),
    emoji: z.string().optional().describe("New emoji."),
  },
  WRITE,
  async ({ label_id, ...fields }) =>
    text(await api(`/labels/${label_id}`, { method: "PUT", body: { label: present(fields) } })),
);

server.tool(
  "timely_delete_label",
  "Delete a label. Entries keep their hours but lose the label.",
  { label_id: z.number().describe("Label to delete.") },
  DESTRUCTIVE,
  async ({ label_id }) => text(await api(`/labels/${label_id}`, { method: "DELETE" })),
);

// ---------------------------------------------------------------------------
// Time entries
// ---------------------------------------------------------------------------

server.tool(
  "timely_list_events",
  "Logged time entries, filtered by day, user or project.",
  {
    since: z.string().optional().describe("First day as YYYY-MM-DD."),
    upto: z.string().optional().describe("Last day as YYYY-MM-DD."),
    user_ids: z.string().optional().describe("Comma-separated user ids."),
    project_ids: z.string().optional().describe("Comma-separated project ids."),
    limit: z.number().optional().describe("Maximum entries to return."),
    page: z.number().optional().describe("Page number when paging through results."),
  },
  READ_ONLY,
  async (query) => text(await api("/events", { query })),
);

server.tool(
  "timely_get_event",
  "One time entry in full.",
  { event_id: z.number().describe("Entry id from timely_list_events.") },
  READ_ONLY,
  async ({ event_id }) => text(await api(`/events/${event_id}`)),
);

server.tool(
  "timely_create_event",
  "Log time to a project.",
  {
    project_id: z.number().describe("Project to log against."),
    day: z.string().describe("Day as YYYY-MM-DD."),
    hours: z.number().optional().describe("Whole hours."),
    minutes: z.number().optional().describe("Minutes, on top of hours."),
    note: z.string().optional().describe("What the time was spent on."),
    user_id: z.number().optional().describe("Whose time this is. Defaults to you."),
    label_ids: z.array(z.number()).optional().describe("Labels to attach."),
    billable: z.boolean().optional().describe("Whether this entry is billable."),
    from: z.string().optional().describe("Start time as HH:MM, for a timed entry."),
    to: z.string().optional().describe("End time as HH:MM, for a timed entry."),
  },
  WRITE,
  async (fields) => text(await api("/events", { method: "POST", body: { event: present(fields) } })),
);

server.tool(
  "timely_update_event",
  "Change a time entry. Only what you pass changes.",
  {
    event_id: z.number().describe("Entry to update."),
    project_id: z.number().optional().describe("Move to another project."),
    day: z.string().optional().describe("New day as YYYY-MM-DD."),
    hours: z.number().optional().describe("New whole hours."),
    minutes: z.number().optional().describe("New minutes."),
    note: z.string().optional().describe("New note."),
    label_ids: z.array(z.number()).optional().describe("Replacement set of labels."),
    billable: z.boolean().optional().describe("Whether this entry is billable."),
    from: z.string().optional().describe("New start time as HH:MM."),
    to: z.string().optional().describe("New end time as HH:MM."),
  },
  WRITE,
  async ({ event_id, ...fields }) =>
    text(await api(`/events/${event_id}`, { method: "PUT", body: { event: present(fields) } })),
);

server.tool(
  "timely_delete_event",
  "Delete a time entry.",
  { event_id: z.number().describe("Entry to delete.") },
  DESTRUCTIVE,
  async ({ event_id }) => text(await api(`/events/${event_id}`, { method: "DELETE" })),
);

server.tool(
  "timely_user_events",
  "One person's entries over a period.",
  {
    user_id: z.number().describe("Whose entries to read."),
    since: z.string().optional().describe("First day as YYYY-MM-DD."),
    upto: z.string().optional().describe("Last day as YYYY-MM-DD."),
  },
  READ_ONLY,
  async ({ user_id, ...query }) => text(await api(`/users/${user_id}/events`, { query })),
);

// ---------------------------------------------------------------------------
// Planned work
// ---------------------------------------------------------------------------

server.tool(
  "timely_list_forecasts",
  "Planned work: what is scheduled, for whom and when.",
  {
    since: z.string().optional().describe("First day as YYYY-MM-DD."),
    upto: z.string().optional().describe("Last day as YYYY-MM-DD."),
  },
  READ_ONLY,
  async (query) => text(await api("/forecasts", { query })),
);

server.tool(
  "timely_get_forecast",
  "One piece of planned work in full.",
  { forecast_id: z.number().describe("Forecast id from timely_list_forecasts.") },
  READ_ONLY,
  async ({ forecast_id }) => text(await api(`/forecasts/${forecast_id}`)),
);

server.tool(
  "timely_create_forecast",
  "Plan work for someone on a project.",
  {
    project_id: z.number().describe("Project the work belongs to."),
    user_id: z.number().describe("Who is scheduled to do it."),
    note: z.string().optional().describe("What the planned work is."),
    estimated_duration: z.number().optional().describe("Planned time in seconds."),
    from: z.string().optional().describe("First day as YYYY-MM-DD."),
    to: z.string().optional().describe("Last day as YYYY-MM-DD."),
  },
  WRITE,
  async (fields) => text(await api("/forecasts", { method: "POST", body: { forecast: present(fields) } })),
);

server.tool(
  "timely_update_forecast",
  "Change planned work. Only what you pass changes.",
  {
    forecast_id: z.number().describe("Forecast to update."),
    project_id: z.number().optional().describe("Move to another project."),
    user_id: z.number().optional().describe("Reassign to someone else."),
    note: z.string().optional().describe("New description."),
    estimated_duration: z.number().optional().describe("New planned time in seconds."),
    from: z.string().optional().describe("New first day."),
    to: z.string().optional().describe("New last day."),
  },
  WRITE,
  async ({ forecast_id, ...fields }) =>
    text(await api(`/forecasts/${forecast_id}`, { method: "PUT", body: { forecast: present(fields) } })),
);

server.tool(
  "timely_delete_forecast",
  "Delete planned work.",
  { forecast_id: z.number().describe("Forecast to delete.") },
  DESTRUCTIVE,
  async ({ forecast_id }) => text(await api(`/forecasts/${forecast_id}`, { method: "DELETE" })),
);

// ---------------------------------------------------------------------------
// Reporting and activity
// ---------------------------------------------------------------------------

/**
 * Compact a report to its figures.
 *
 * Timely repeats a thirteen-field duration and cost object on every row and
 * nests each client's projects inside it, so a month across an account runs to
 * hundreds of kilobytes of mostly redundant numbers.
 */
function summarise(report: Record<string, unknown>): Record<string, unknown> {
  const hours = (value: unknown) => (value as { formatted?: string } | undefined)?.formatted;
  const money = (value: unknown) => (value as { amount?: number } | undefined)?.amount;

  const row = (item: unknown): Record<string, unknown> => {
    const r = item as Record<string, unknown>;
    return present({
      id: r.id,
      name: r.name ?? r.day,
      hours: hours(r.duration),
      billable_hours: hours(r.billable_duration),
      cost: money(r.cost),
      profit: money(r.profit),
      projects: Array.isArray(r.projects) ? (r.projects as unknown[]).map(row) : undefined,
    });
  };

  const group = (rows: unknown) => (Array.isArray(rows) ? rows.map(row) : rows);

  return {
    totals: present({
      hours: hours((report.totals as Record<string, unknown>)?.duration),
      billable_hours: hours((report.totals as Record<string, unknown>)?.billable_duration),
      cost: money((report.totals as Record<string, unknown>)?.cost),
      profit: money((report.totals as Record<string, unknown>)?.profit),
    }),
    clients: group(report.clients),
    users: group(report.users),
    labels: group(report.labels),
    days: group(report.days),
  };
}

server.tool(
  "timely_report",
  "Totals for a period, grouped by client, user, label and day.",
  {
    since: z.string().describe("First day as YYYY-MM-DD."),
    upto: z.string().describe("Last day as YYYY-MM-DD."),
    user_ids: z.array(z.number()).optional().describe("Limit to these users."),
    project_ids: z.array(z.number()).optional().describe("Limit to these projects."),
    client_ids: z.array(z.number()).optional().describe("Limit to these clients."),
    label_ids: z.array(z.number()).optional().describe("Limit to these labels."),
    billable: z.boolean().optional().describe("Restrict to billable or non-billable time."),
    detail: z
      .boolean()
      .optional()
      .describe(
        "Include every underlying entry. Off by default: a month across an " +
          "account runs to hundreds of kilobytes, which is rarely what a summary needs.",
      ),
  },
  READ_ONLY,
  async ({ detail, ...fields }) => {
    const report = (await api("/reports/filter", {
      method: "POST",
      body: present(fields),
    })) as Record<string, unknown>;

    return text(detail ? report : summarise(report));
  },
);

server.tool(
  "timely_list_reports",
  "Saved reports on the account.",
  {},
  READ_ONLY,
  async () => text(await api("/reports")),
);

server.tool(
  "timely_activities",
  "Recent account activity: what was logged or changed, and by whom.",
  { limit: z.number().optional().describe("Maximum entries to return.") },
  READ_ONLY,
  async ({ limit }) => text(await api("/activities", { query: { limit } })),
);

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

server.tool("timely_list_webhooks", "Webhooks registered on the account.", {}, READ_ONLY, async () =>
  text(await api("/webhooks")),
);

server.tool(
  "timely_create_webhook",
  "Register a webhook for account events.",
  {
    url: z.string().describe("HTTPS endpoint to call."),
    subscriptions: z.array(z.string()).describe("Events to subscribe to, e.g. event.created."),
  },
  WRITE,
  async (fields) => text(await api("/webhooks", { method: "POST", body: { webhook: fields } })),
);

server.tool(
  "timely_delete_webhook",
  "Remove a webhook.",
  { webhook_id: z.number().describe("Webhook to delete.") },
  DESTRUCTIVE,
  async ({ webhook_id }) => text(await api(`/webhooks/${webhook_id}`, { method: "DELETE" })),
);

  return server;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * One transport and one server per session.
 *
 * An McpServer binds to a single transport, so a shared one accepts the first
 * client and answers every later initialize with "Server already initialized".
 */
async function serveHttp(host: string, port: number): Promise<void> {
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to listen on ${host}: this server has no login of its own. ` +
        "Keep it local and put auth-server.cjs in front of it.",
    );
  }

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function openSession(): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => sessions.set(id, transport),
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await buildServer().connect(transport);
    return transport;
  }

  createServer((req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        const body = raw ? JSON.parse(raw) : undefined;
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        const transport = sessionId ? sessions.get(sessionId) : await openSession();

        if (!transport) {
          res.writeHead(404).end();
          return;
        }

        await transport.handleRequest(req, res, body);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      }
    });
  }).listen(port, host, () => {
    console.error(`timely-mcp listening on http://${host}:${port}/mcp`);
  });
}

const args = process.argv.slice(2);
const transportArg = args.includes("--transport") ? args[args.indexOf("--transport") + 1] : "stdio";

if (transportArg === "http") {
  const host = args.includes("--host") ? args[args.indexOf("--host") + 1] : "127.0.0.1";
  const port = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : DEFAULT_PORT);
  await serveHttp(host, port);
} else {
  await buildServer().connect(new StdioServerTransport());
}
