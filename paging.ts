// Keeps tool results small enough for a chat client to accept. A result over
// BUDGET is kept here and answered with its first page, the total and the field
// names; get_result_page reads the rest, so nothing is lost.
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Characters per response, about 20 000 tokens. */
export const BUDGET = 80_000;
/** Lists smaller than this stay in the first page; larger ones are paged. */
const INLINE = 2_000;

// ponytail: count-capped LRU in process memory; results are lost on restart.
const KEPT = 8;
type Path = string[];
const results = new Map<string, { payload: unknown; lists: Map<string, Path> }>();

const HINT =
  "Large result, sent in pages. Call get_result_page with this result_id and next_offset for more, " +
  "or path to page another of the lists. Pass fields to fetch only some keys, or match to filter, " +
  'e.g. {"title": "alien"}.';

const dump = (value: unknown) => JSON.stringify(value) ?? "null";
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const at = (value: unknown, path: Path): any => path.reduce((node: any, key) => node[key], value);
const name = (path: Path) => path.join(".");

/** Every list worth paging, keyed by dotted path, largest first. */
function listsOf(payload: unknown): Map<string, Path> {
  const found: [Path, number][] = [];
  const walk = (value: unknown, path: Path, depth: number) => {
    if (Array.isArray(value)) {
      const size = dump(value).length;
      if (size >= INLINE || path.length === 0) found.push([path, size]);
    } else if (isObject(value) && depth <= 4) {
      for (const [key, child] of Object.entries(value)) walk(child, [...path, key], depth + 1);
    }
  };
  walk(payload, [], 0);
  found.sort((a, b) => b[1] - a[1]);
  return new Map(found.map(([path]) => [name(path), path]));
}

function get(item: unknown, field: string): unknown {
  let node = item;
  for (const key of field.split(".")) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

const matches = (item: unknown, match: Record<string, string>) =>
  Object.entries(match).every(([field, want]) =>
    dump(get(item, field) ?? null).toLowerCase().includes(String(want).toLowerCase()),
  );

/** A copy of payload with the list at each path swapped for a new value. */
function replace(payload: unknown, swaps: [Path, unknown][]): unknown {
  const root = swaps.findLast(([path]) => path.length === 0);
  if (root) return root[1];
  const copy: any = { ...(payload as object) };
  for (const [path, value] of swaps) {
    let node = copy;
    for (const key of path.slice(0, -1)) {
      node[key] = { ...node[key] };
      node = node[key];
    }
    node[path[path.length - 1]] = value;
  }
  return copy;
}

const emptied = (lists: Map<string, Path>): [Path, unknown][] => [...lists.values()].map((p) => [p, []]);

/** Serialise a tool's answer, paging it when it is over BUDGET. */
export function fit(payload: unknown): string {
  const text = dump(payload);
  if (text.length <= BUDGET) return text;

  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  let lists = listsOf(payload);
  if (lists.size && dump(replace(payload, emptied(lists))).length > BUDGET / 2) lists = new Map();
  results.set(id, { payload: lists.size ? payload : text, lists });
  while (results.size > KEPT) results.delete(results.keys().next().value!);
  return page(id);
}

function textPage(id: string, text: string, offset: number): string {
  // Escaping inside a JSON string grows the text, so shrink until it fits.
  let end = offset + BUDGET - 1_000;
  while (dump(text.slice(offset, end)).length > BUDGET - 1_000) end = offset + Math.floor(((end - offset) * 9) / 10);
  return dump({
    partial_json: text.slice(offset, end),
    paging: {
      result_id: id,
      total_chars: text.length,
      offset,
      next_offset: end < text.length ? end : null,
      hint: "Too large to split into items. Concatenate partial_json from every page to rebuild it.",
    },
  });
}

export function page(
  id: string,
  offset = 0,
  limit?: number,
  fields?: string[],
  match?: Record<string, string>,
  path?: string,
): string {
  const entry = results.get(id);
  if (!entry) return dump({ status: "error", message: "That result has expired. Call the original tool again." });
  results.delete(id);
  results.set(id, entry);
  const { payload, lists } = entry;
  if (!lists.size) return textPage(id, payload as string, offset);

  const key = path ?? lists.keys().next().value!;
  const chosen = lists.get(key);
  if (!chosen) {
    return dump({ status: "error", message: `No list at "${key}". Choose one of: ${[...lists.keys()].join(", ")}.` });
  }

  let items = at(payload, chosen) as unknown[];
  if (match) items = items.filter((i) => matches(i, match));
  const total = items.length;
  let window = items.slice(offset);
  if (limit !== undefined) window = window.slice(0, limit);
  if (fields?.length) window = window.map((i) => Object.fromEntries(fields.map((f) => [f, get(i, f) ?? null])));

  const sample = items.find(isObject);
  const paging: Record<string, unknown> = {
    result_id: id,
    path: name(chosen) || null,
    lists: lists.size > 1 ? Object.fromEntries([...lists].map(([k, p]) => [k, at(payload, p).length])) : null,
    total,
    offset,
    fields: sample ? Object.keys(sample).sort() : null,
    hint: HINT,
  };
  let used = dump({ page: replace(payload, emptied(lists)), paging }).length + 200;

  const taken: unknown[] = [];
  for (const item of window) {
    const size = dump(item).length + 1;
    if (taken.length && used + size > BUDGET) break;
    taken.push(item);
    used += size;
  }

  const following = offset + taken.length;
  paging.returned = taken.length;
  paging.next_offset = following < total ? following : null;

  const out = replace(payload, [...emptied(lists), [chosen, taken]]);
  return dump(isObject(out) ? { ...out, paging } : { result: out, paging });
}

/** Add get_result_page to a server. */
export function registerPaging(server: McpServer): void {
  server.tool(
    "get_result_page",
    "Read more of a result that was too large to return in one piece. Any tool whose answer is too " +
      "large returns its first page with a `paging` block; pass its result_id here. Nothing is fetched " +
      "again: the stored result is paged, filtered and narrowed.",
    {
      result_id: z.string().describe("From the `paging` block of the earlier answer."),
      offset: z.number().int().min(0).default(0).describe("First item to return, usually the previous next_offset."),
      limit: z.number().int().min(1).optional().describe("At most this many items. Fewer come back if they would not fit."),
      fields: z
        .array(z.string())
        .optional()
        .describe('Only these keys of each item. Dots reach nested keys, such as "client.name". paging.fields lists them.'),
      match: z
        .record(z.string(), z.string())
        .optional()
        .describe('Keep only items whose field contains this text, ignoring case, e.g. {"name": "dude"}.'),
      path: z
        .string()
        .optional()
        .describe("Which list to page when the result holds several, as named in paging.lists. Defaults to the largest."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ result_id, offset, limit, fields, match, path }) => ({
      content: [{ type: "text" as const, text: page(result_id, offset, limit, fields, match, path) }],
    }),
  );
}
