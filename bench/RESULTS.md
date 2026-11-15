# Proxy overhead (Apple M5, Node 22.23, native processes, demo API on localhost)

Query: `user(id) { id name posts(first: 3) { id title comments { totalCount } } }` with variables, every request analysed and logged.

```
# fixed rate, 2000 req/s
direct  http://127.0.0.1:5500/graphql
  p50 0 ms, p97.5 3 ms, p99 3 ms, avg 0.46 ms, 2000 req/s, errors 0
proxy   http://127.0.0.1:5400/graphql
  p50 1 ms, p97.5 4 ms, p99 6 ms, avg 1.44 ms, 2000 req/s, errors 0

end-to-end latency added by the proxy (avg): 0.98 ms
proxy-only overhead histogram (20020 requests, bucket upper bounds): p50 ≤ 0.5 ms, p95 ≤ 0.5 ms, p99 ≤ 0.5 ms

# saturation, 20 connections
direct  http://127.0.0.1:5500/graphql
  p50 0 ms, p97.5 1 ms, p99 1 ms, avg 0.07 ms, 31266 req/s, errors 0
proxy   http://127.0.0.1:5400/graphql
  p50 1 ms, p97.5 6 ms, p99 7 ms, avg 1.40 ms, 11890 req/s, errors 0

end-to-end latency added by the proxy (avg): 1.33 ms
proxy-only overhead histogram (118929 requests, bucket upper bounds): p50 ≤ 0.5 ms, p95 ≤ 0.5 ms, p99 ≤ 0.5 ms
```
