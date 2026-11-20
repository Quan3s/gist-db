// Package gistdb provides a Go client for gist-db servers.
//
// gist-db stores data in GitHub Gists and supports two modes:
//   - KV (Redis-like): key/value, hashes, lists, sets, counters, TTL metadata
//   - Table (PostgreSQL-like): schema tables, CRUD, simple WHERE queries, mini SQL subset
//
// The server exposes REST (HTTP JSON) and TCP (JSON-line) transports.
// Connect using a URL similar to SQL/Redis DSNs:
//
//   gistdb://host:3011/mydb?mode=kv      // TCP JSONL (default for gistdb scheme)
//   gistdb://host:3011/mydb?mode=table
//   http://host:3010                      // REST
//
// Example:
//
//   client, err := gistdb.Open("gistdb://127.0.0.1:3011/mykv?mode=kv")
//   if err != nil { panic(err) }
//   defer client.Close()
//   kv := client.KV("mykv")
//   _, _ = kv.Set(ctx, "hello", "world", nil)
//   val, ok, _ := kv.Get(ctx, "hello")
//
//   tdb := client.Table("mydb")
//   rows, _ := tdb.Query(ctx, "SELECT * FROM users WHERE age >= 18")
package gistdb
