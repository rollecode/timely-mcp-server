import { expect, test } from "bun:test";
import { BUDGET, fit, page } from "./paging.ts";

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i, title: `Film ${i}`, blob: "x".repeat(500), meta: { year: 1970 + (i % 50) } }));

const read = (text: string) => {
  expect(text.length).toBeLessThanOrEqual(BUDGET);
  return JSON.parse(text);
};

test("small results pass through whole", () => {
  expect(read(fit([{ id: 1 }]))).toEqual([{ id: 1 }]);
});

test("paging reaches every item exactly once", () => {
  let data = read(fit({ status: "success", result: items(2000) }));
  const seen: number[] = data.result.map((i: any) => i.id);
  const id = data.paging.result_id;
  while (data.paging.next_offset !== null) {
    data = read(page(id, data.paging.next_offset));
    seen.push(...data.result.map((i: any) => i.id));
  }
  expect(seen).toEqual(Array.from({ length: 2000 }, (_, i) => i));
});

test("fields and match narrow the page", () => {
  const id = read(fit(items(2000))).paging.result_id;
  const data = read(page(id, 0, undefined, ["title", "meta.year"], { "meta.year": "1979" }));
  expect(data.paging.total).toBe(40);
  expect(data.result[0]).toEqual({ title: "Film 9", "meta.year": 1979 });
  expect(data.paging.next_offset).toBeNull();
});

test("a bare list comes back under result", () => {
  const data = read(fit(items(2000)));
  expect(data.paging.path).toBeNull();
  expect(data.result.length).toBe(data.paging.returned);
});

test("text without a list is paged by characters", () => {
  let data = read(fit({ doc: '"'.repeat(300_000) }));
  let text = data.partial_json;
  while (data.paging.next_offset !== null) {
    data = read(page(data.paging.result_id, data.paging.next_offset));
    text += data.partial_json;
  }
  expect(JSON.parse(text)).toEqual({ doc: '"'.repeat(300_000) });
});

test("an expired result says so", () => {
  expect(JSON.parse(page("nope")).status).toBe("error");
});

test("every big list is reachable by path", () => {
  const budget = { data: { budget: { name: "Home", transactions: items(2000), payees: items(1500), flags: [1, 2] } } };
  const data = read(fit(budget));
  expect(data.paging.lists).toEqual({ "data.budget.transactions": 2000, "data.budget.payees": 1500 });
  expect(data.data.budget.flags).toEqual([1, 2]);
  expect(data.data.budget.name).toBe("Home");
  const next = read(page(data.paging.result_id, 0, undefined, ["id"], undefined, "data.budget.payees"));
  expect(next.paging.total).toBe(1500);
  expect(next.data.budget.transactions).toEqual([]);
});
