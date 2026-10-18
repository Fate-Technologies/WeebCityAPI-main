import { monitorEventLoopDelay } from "node:perf_hooks";

const latencyBuckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const routes = new Map<string, { count: number; sum: number; errors: number; buckets: number[] }>();
const cache = { hit: 0, stale: 0, miss: 0, error: 0 };
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
setInterval(() => loop.reset(), 60_000).unref();

export function recordRequest(route: string, seconds: number, status: number) {
  // Only router patterns, never user ids, URLs, tokens, or query strings.
  const key = routes.has(route) || routes.size < 128 ? route : "other";
  const row = routes.get(key) || { count: 0, sum: 0, errors: 0, buckets: latencyBuckets.map(() => 0) };
  row.count++; row.sum += seconds; row.errors += Number(status >= 500);
  latencyBuckets.forEach((boundary, i) => { if (seconds <= boundary) row.buckets[i]++; });
  routes.set(key, row);
}
export function recordCache(result: keyof typeof cache) { cache[result]++; }
export function metricsText() {
  const lines = ["# TYPE tatakai_request_duration_seconds histogram", "# TYPE tatakai_request_errors_total counter"];
  for (const [route, row] of routes) {
    const label = JSON.stringify(route);
    latencyBuckets.forEach((boundary, i) => lines.push(`tatakai_request_duration_seconds_bucket{route=${label},le="${boundary}"} ${row.buckets[i]}`));
    lines.push(`tatakai_request_duration_seconds_bucket{route=${label},le="+Inf"} ${row.count}`,
      `tatakai_request_duration_seconds_count{route=${label}} ${row.count}`,
      `tatakai_request_duration_seconds_sum{route=${label}} ${row.sum}`,
      `tatakai_request_errors_total{route=${label}} ${row.errors}`);
  }
  lines.push("# TYPE tatakai_cache_requests_total counter");
  for (const [result, count] of Object.entries(cache)) lines.push(`tatakai_cache_requests_total{result="${result}"} ${count}`);
  lines.push(`tatakai_process_resident_memory_bytes ${process.memoryUsage().rss}`,
    `tatakai_process_heap_used_bytes ${process.memoryUsage().heapUsed}`,
    `tatakai_event_loop_p95_seconds ${loop.percentile(95) / 1e9}`);
  return lines.join("\n") + "\n";
}
