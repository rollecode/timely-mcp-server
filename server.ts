import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { api, accountId } from "./timely.ts";

const VERSION = "2.1.0";
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
      "log time. timely_report is the one to reach for when summarising a period. " +
      "For money questions, timely_project_rates shows what a project charges " +
      "against what its people cost, and timely_unrated_work finds billable hours " +
      "earning nothing. Fixing many entries at once is timely_set_events_billable, " +
      "which has a dry_run.",
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

/**
 * Timely's own codes for a project budget. It rejects the words the docs use,
 * so the tools take the readable name and send the letter.
 */
const BUDGET_TYPES: Record<string, string> = { hours: "H", fees: "M", money: "M" };

const RATE_TYPES = ["user", "project", "non-billable"] as const;

/**
 * Fail on a write Timely accepted but ignored.
 *
 * A PUT with a field name Timely does not recognise still answers 200 with a
 * bumped updated_at, so the response alone is not evidence the change landed.
 * Comparing what came back against what was sent is.
 */
function assertApplied(
  resource: Record<string, unknown>,
  sent: Record<string, unknown>,
  fields: string[],
): void {
  const same = (a: unknown, b: unknown) =>
    typeof a === "number" || typeof b === "number" ? Number(a) === Number(b) : a === b;

  const dropped = fields
    .filter((field) => sent[field] !== undefined && !same(sent[field], resource[field]))
    .map((field) => `${field} (sent ${JSON.stringify(sent[field])}, got ${JSON.stringify(resource[field])})`);

  if (dropped.length > 0) {
    throw new Error(
      `Timely returned success but did not apply: ${dropped.join(", ")}. ` +
        "The value was rejected or the field is not writable on this plan.",
    );
  }
}

const PROJECT_WRITABLE = ["name", "billable", "rate_type", "hour_rate", "budget", "budget_type", "active"];

/** Map the friendly budget name onto Timely's letter, rejecting anything else. */
function budgetCode(budget_type?: string): string | undefined {
  if (budget_type === undefined) {
    return undefined;
  }
  const code = BUDGET_TYPES[budget_type.toLowerCase()];
  if (!code) {
    throw new Error(`budget_type must be one of ${Object.keys(BUDGET_TYPES).join(", ")}.`);
  }
  return code;
}

const hoursOf = (value: unknown) => (value as { formatted?: string } | undefined)?.formatted;
const amountOf = (value: unknown) => (value as { amount?: number } | undefined)?.amount;

/**
 * Reduce an entry to its figures.
 *
 * Every entry embeds its whole project, client and user, so a day across the
 * account is hundreds of kilobytes of repeated records.
 */
function compactEvent(item: unknown): Record<string, unknown> {
  const e = item as Record<string, unknown>;
  const project = e.project as Record<string, unknown> | undefined;
  const client = project?.client as Record<string, unknown> | undefined;
  const user = e.user as Record<string, unknown> | undefined;

  return present({
    id: e.id,
    day: e.day,
    hours: hoursOf(e.duration),
    note: e.note,
    user_id: user?.id,
    user: user?.name,
    project_id: project?.id,
    project: project?.name,
    client: client?.name,
    billable: e.billable,
    billed: e.billed,
    invoice_id: e.invoice_id,
    locked: e.locked,
    hour_rate: e.hour_rate,
    cost: amountOf(e.cost),
    internal_cost: amountOf(e.internal_cost),
    label_ids: e.label_ids,
    from: e.from,
    to: e.to,
  });
}

// ---------------------------------------------------------------------------
// Account and people
// ---------------------------------------------------------------------------

server.tool(
  "timely_me",
  "The accounts the signed-in token can reach, and which one this server uses.",
  {},
  READ_ONLY,
  async () => text({ account_id: accountId, accounts: await api("/accounts", { scope: "root" }) }),
);

server.tool(
  "timely_account",
  "Account settings: name, currency, week start, capacity and the default hour rate.",
  {},
  READ_ONLY,
  async () => text(await api(`/accounts/${accountId}`, { scope: "root" })),
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
  "One user in full, including default_hour_rate (what clients pay) and internal_hour_rate (what they cost).",
  { user_id: z.number().describe("User id from timely_list_users.") },
  READ_ONLY,
  async ({ user_id }) => text(await api(`/users/${user_id}`)),
);

server.tool(
  "timely_update_user",
  "Change a user's rates or working week. Only what you pass changes. " +
    "default_hour_rate is what the client is charged; internal_hour_rate is what the person costs. " +
    "Leaving the two equal is what makes every report show zero or negative profit.",
  {
    user_id: z.number().describe("User to update."),
    default_hour_rate: z.number().optional().describe("Charge-out rate in the account currency."),
    internal_hour_rate: z.number().optional().describe("Internal cost rate in the account currency."),
    weekly_capacity: z.number().optional().describe("Contracted hours per week."),
    work_days: z.string().optional().describe("Working days, e.g. MON,TUE,WED,THU,FRI."),
    active: z.boolean().optional().describe("False deactivates the user."),
  },
  WRITE,
  async ({ user_id, ...fields }) => {
    const sent = present(fields);
    const user = (await api(`/users/${user_id}`, { method: "PUT", body: { user: sent } })) as Record<string, unknown>;
    assertApplied(user, sent, ["default_hour_rate", "internal_hour_rate", "weekly_capacity", "work_days", "active"]);
    return text(user);
  },
);

server.tool(
  "timely_user_capacities",
  "A user's capacity periods: contracted hours per week and per day, and when each applied.",
  { user_id: z.number().describe("User id from timely_list_users.") },
  READ_ONLY,
  async ({ user_id }) => text(await api(`/users/${user_id}/capacities`)),
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

const projectRateFields = {
  rate_type: z
    .enum(RATE_TYPES)
    .describe(
      "How the project is charged. 'project' bills every hour at hour_rate, " +
        "'user' bills each person at their own rate, 'non-billable' bills nothing.",
    ),
  hour_rate: z.number().optional().describe("Charge-out rate, used when rate_type is 'project'."),
  users: z
    .array(
      z.object({
        user_id: z.number().describe("Who this rate applies to."),
        hour_rate: z.number().describe("What the client pays for this person's time."),
      }),
    )
    .optional()
    .describe("Per-person charge-out rates. Required when rate_type is 'user'."),
};

server.tool(
  "timely_create_project",
  "Create a project under a client. rate_type is required: Timely rejects a project without one.",
  {
    name: z.string().describe("Project name."),
    client_id: z.number().describe("Client the project belongs to."),
    ...projectRateFields,
    color: z.string().optional().describe("Hex colour without the hash, e.g. A020F0."),
    budget: z.number().optional().describe("Budget in hours or currency, per budget_type."),
    budget_type: z.string().optional().describe("Either 'hours' or 'fees'."),
    billable: z.boolean().optional().describe("Whether time logged is billable."),
    external_id: z.string().optional().describe("Your own reference, e.g. a CRM id."),
    notes_required: z.boolean().optional().describe("Require a note on every entry."),
  },
  WRITE,
  async ({ budget_type, notes_required, ...fields }) => {
    const body = present({ ...fields, budget_type: budgetCode(budget_type), required_notes: notes_required });
    return text(await api("/projects", { method: "POST", body: { project: body } }));
  },
);

server.tool(
  "timely_update_project",
  "Change a project. Only what you pass changes. Fails loudly if Timely accepts the " +
    "request but drops a value, rather than reporting a success that did not happen.",
  {
    project_id: z.number().describe("Project to update."),
    name: z.string().optional().describe("New name."),
    client_id: z.number().optional().describe("Move to another client."),
    ...projectRateFields,
    rate_type: projectRateFields.rate_type
      .optional()
      .describe(
        "How the project is charged: 'project', 'user' or 'non-billable'. " +
          "Set this alongside hour_rate; a rate alone on a non-billable project earns nothing.",
      ),
    color: z.string().optional().describe("Hex colour without the hash."),
    budget: z.number().optional().describe("New budget."),
    budget_type: z.string().optional().describe("Either 'hours' or 'fees'."),
    billable: z.boolean().optional().describe("Whether time logged is billable."),
    active: z.boolean().optional().describe("False archives the project."),
    external_id: z.string().optional().describe("Your own reference."),
  },
  WRITE,
  async ({ project_id, budget_type, ...fields }) => {
    const sent = present({ ...fields, budget_type: budgetCode(budget_type) });
    const project = (await api(`/projects/${project_id}`, {
      method: "PUT",
      body: { project: sent },
    })) as Record<string, unknown>;

    assertApplied(project, sent, PROJECT_WRITABLE);
    return text(project);
  },
);

server.tool(
  "timely_delete_project",
  "Delete a project. Its time entries go with it. Archive instead with active: false.",
  { project_id: z.number().describe("Project to delete.") },
  DESTRUCTIVE,
  async ({ project_id }) => text(await api(`/projects/${project_id}`, { method: "DELETE" })),
);

server.tool(
  "timely_project_rates",
  "How a project charges: its rate type, project rate and every per-person rate, " +
    "next to what each person costs internally. Use this to see why a project earns what it does.",
  { project_id: z.number().describe("Project id from timely_list_projects.") },
  READ_ONLY,
  async ({ project_id }) => {
    const project = (await api(`/projects/${project_id}`)) as Record<string, unknown>;
    const staff = (await api("/users")) as Array<Record<string, unknown>>;
    const byId = new Map(staff.map((u) => [u.id, u]));

    const rates = ((project.users ?? []) as Array<Record<string, unknown>>)
      .filter((u) => !u.deleted)
      .map((u) => {
        const person = byId.get(u.user_id);
        return present({
          user_id: u.user_id,
          name: person?.name,
          charged: u.hour_rate,
          costs: person?.internal_hour_rate,
          margin_per_hour: Number(u.hour_rate ?? 0) - Number(person?.internal_hour_rate ?? 0),
        });
      });

    return text({
      id: project.id,
      name: project.name,
      client: (project.client as Record<string, unknown> | undefined)?.name,
      billable: project.billable,
      rate_type: project.rate_type,
      project_hour_rate: project.hour_rate,
      budget: project.budget,
      budget_type: project.budget_type,
      budget_percent: project.budget_percent,
      user_rates: rates,
    });
  },
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

/**
 * Read entries through whichever endpoint actually filters.
 *
 * The collection endpoint ignores project_ids, user_ids, label_ids and
 * billable: it answers 200 and returns the whole account, so a caller asking
 * for one person's hours would otherwise be handed everybody's and never know.
 * Only the singular nested routes filter server-side; the rest is done here.
 */
async function readEvents(filter: {
  since?: string;
  upto?: string;
  user_id?: number;
  project_id?: number;
  billable?: boolean;
  billed?: boolean;
  label_id?: number;
  per_page?: number;
  page?: number;
}): Promise<Array<Record<string, unknown>>> {
  const { user_id, project_id, billable, billed, label_id, ...query } = filter;

  const path = project_id
    ? `/projects/${project_id}/events`
    : user_id
      ? `/users/${user_id}/events`
      : "/events";

  const rows = (await api(path, {
    query: project_id && user_id ? { ...query, user_id } : query,
  })) as Array<Record<string, unknown>>;

  return rows.filter((event) => {
    const user = event.user as Record<string, unknown> | undefined;
    const labels = (event.label_ids ?? []) as number[];

    if (project_id && user_id && user?.id !== user_id) {
      return false;
    }
    if (billable !== undefined && event.billable !== billable) {
      return false;
    }
    if (billed !== undefined && event.billed !== billed) {
      return false;
    }
    if (label_id !== undefined && !labels.includes(label_id)) {
      return false;
    }
    return true;
  });
}

server.tool(
  "timely_list_events",
  "Logged time entries for a period, narrowed by user, project, label or billing state. " +
    "Returns a compact row per entry; ask for detail to get Timely's full payload.",
  {
    since: z.string().optional().describe("First day as YYYY-MM-DD."),
    upto: z.string().optional().describe("Last day as YYYY-MM-DD."),
    user_id: z.number().optional().describe("Only this person's entries."),
    project_id: z.number().optional().describe("Only this project's entries."),
    label_id: z.number().optional().describe("Only entries carrying this label."),
    billable: z.boolean().optional().describe("Only billable, or only non-billable, entries."),
    billed: z.boolean().optional().describe("Only invoiced, or only uninvoiced, entries."),
    per_page: z.number().optional().describe("Entries per page. Timely ignores 'limit' here."),
    page: z.number().optional().describe("Page number when paging through results."),
    detail: z.boolean().optional().describe("Return Timely's full entry payload instead of a compact row."),
  },
  READ_ONLY,
  async ({ detail, ...filter }) => {
    const rows = await readEvents(filter);
    return text({ count: rows.length, events: detail ? rows : rows.map(compactEvent) });
  },
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
    estimated: z.boolean().optional().describe("Log as planned rather than actual time."),
    external_id: z.string().optional().describe("Your own reference for this entry."),
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
    user_id: z.number().optional().describe("Reassign the entry to someone else."),
    external_id: z.string().optional().describe("Your own reference for this entry."),
  },
  WRITE,
  async ({ event_id, ...fields }) => {
    const sent = present(fields);
    const event = (await api(`/events/${event_id}`, { method: "PUT", body: { event: sent } })) as Record<
      string,
      unknown
    >;
    assertApplied(event, sent, ["day", "note", "billable", "from", "to"]);
    return text(event);
  },
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
    detail: z.boolean().optional().describe("Return Timely's full entry payload instead of a compact row."),
  },
  READ_ONLY,
  async ({ user_id, detail, ...query }) => {
    const rows = (await api(`/users/${user_id}/events`, { query })) as Array<Record<string, unknown>>;
    return text({ count: rows.length, events: detail ? rows : rows.map(compactEvent) });
  },
);

/** Timely has no bulk write, so a sweep is this many single updates. */
const BULK_CONCURRENCY = 6;

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += BULK_CONCURRENCY) {
    results.push(...(await Promise.all(items.slice(i, i + BULK_CONCURRENCY).map(run))));
  }
  return results;
}

server.tool(
  "timely_set_events_billable",
  "Flip the billable flag on every entry matching a project, person, label or period. " +
    "Timely has no bulk endpoint, so this updates each entry in turn; preview with dry_run first. " +
    "Entries already in the wanted state are left alone, and locked or invoiced ones are reported, not forced.",
  {
    billable: z.boolean().describe("The state to set."),
    since: z.string().describe("First day as YYYY-MM-DD."),
    upto: z.string().describe("Last day as YYYY-MM-DD."),
    project_id: z.number().optional().describe("Limit to one project."),
    user_id: z.number().optional().describe("Limit to one person."),
    label_id: z.number().optional().describe("Limit to entries carrying this label."),
    dry_run: z.boolean().optional().describe("List what would change without writing. Default false."),
  },
  WRITE,
  async ({ billable, dry_run, ...filter }) => {
    const candidates = (await readEvents({ ...filter, billable: !billable })).filter((e) => !e.deleted);
    const locked = candidates.filter((e) => e.locked || e.billed);
    const changeable = candidates.filter((e) => !e.locked && !e.billed);

    if (dry_run) {
      return text({
        dry_run: true,
        would_change: changeable.length,
        skipped_locked_or_invoiced: locked.length,
        events: changeable.map(compactEvent),
      });
    }

    const outcomes = await inBatches(changeable, async (event) => {
      try {
        await api(`/events/${event.id}`, { method: "PUT", body: { event: { billable } } });
        return { id: event.id, ok: true };
      } catch (error) {
        return { id: event.id, ok: false, error: (error as Error).message };
      }
    });

    const failed = outcomes.filter((o) => !o.ok);
    return text({
      billable,
      changed: outcomes.length - failed.length,
      skipped_locked_or_invoiced: locked.map((e) => e.id),
      failed,
    });
  },
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
  const hours = hoursOf;
  const money = amountOf;

  /**
   * Timely's "cost" is what the client is charged and "internal_cost" what the
   * work cost to do, so both are named for what they mean here. Its "profit"
   * is only meaningful once the two underlying rates differ.
   */
  const figures = (r: Record<string, unknown>) =>
    present({
      hours: hours(r.duration),
      billable_hours: hours(r.billable_duration),
      non_billable_hours: hours(r.non_billable_duration),
      invoiced_hours: hours(r.billed_duration),
      uninvoiced_hours: hours(r.unbilled_duration),
      revenue: money(r.cost),
      invoiced_revenue: money(r.billed_cost),
      uninvoiced_revenue: money(r.unbilled_cost),
      internal_cost: money(r.internal_cost),
      profit: money(r.profit),
      profitability: r.profitability,
    });

  const row = (item: unknown): Record<string, unknown> => {
    const r = item as Record<string, unknown>;
    return present({
      id: r.id,
      name: r.name ?? r.day,
      ...figures(r),
      rate_type: r.rate_type,
      hour_rate: r.hour_rate,
      projects: Array.isArray(r.projects) ? (r.projects as unknown[]).map(row) : undefined,
    });
  };

  const group = (rows: unknown) => (Array.isArray(rows) ? rows.map(row) : rows);

  return {
    totals: figures((report.totals ?? {}) as Record<string, unknown>),
    clients: group(report.clients),
    users: group(report.users),
    labels: group(report.labels),
    teams: group(report.teams),
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
  "timely_unrated_work",
  "Projects that logged billable hours yet earn nothing, because the rate is zero. " +
    "This is the query that finds work being given away. Projects deliberately marked " +
    "non-billable are left out unless you ask for them.",
  {
    since: z.string().describe("First day as YYYY-MM-DD."),
    upto: z.string().describe("Last day as YYYY-MM-DD."),
    include_non_billable: z
      .boolean()
      .optional()
      .describe("Also list projects marked non-billable. Off by default: those earn nothing by design."),
  },
  READ_ONLY,
  async ({ since, upto, include_non_billable }) => {
    const report = (await api("/reports/filter", { method: "POST", body: { since, upto } })) as Record<
      string,
      unknown
    >;

    const rows = ((report.clients ?? []) as Array<Record<string, unknown>>).flatMap((client) =>
      ((client.projects ?? []) as Array<Record<string, unknown>>).map((p) => ({ client, p })),
    );

    const loggedHours = (p: Record<string, unknown>, field: string) =>
      Number((p[field] as { total_hours?: number } | undefined)?.total_hours ?? 0);

    const unrated = rows
      .filter(({ p }) =>
        include_non_billable
          ? loggedHours(p, "duration") > 0
          : loggedHours(p, "billable_duration") > 0 && p.rate_type !== "non-billable",
      )
      .filter(({ p }) => Number(amountOf(p.cost) ?? 0) === 0)
      .map(({ client, p }) =>
        present({
          project_id: p.id,
          project: p.name,
          client: client.name,
          hours: hoursOf(p.duration),
          billable_hours: hoursOf(p.billable_duration),
          revenue: amountOf(p.cost),
          internal_cost: amountOf(p.internal_cost),
          rate_type: p.rate_type,
          hour_rate: p.hour_rate,
          reason:
            p.rate_type === "non-billable"
              ? "project is non-billable"
              : Number(p.hour_rate ?? 0) === 0 && p.rate_type === "project"
                ? "project rate is zero"
                : "no charge-out rate on the people who logged time",
        }),
      );

    return text({
      period: { since, upto },
      unrated_projects: unrated.length,
      lost_internal_cost: unrated.reduce((sum, r) => sum + Number(r.internal_cost ?? 0), 0),
      projects: unrated,
    });
  },
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
