# Go example

```bash
# start server first (from repo root)
node gist_db/bin/gistdb.js server --http-port 3010 --tcp-port 3011

# run example (requires Go installed)
cd gist_db/go/example
GISTDB_URL='gistdb://127.0.0.1:3011/mykv?mode=kv' GISTDB_DB=mykv go run .
```

For REST transport, set `GISTDB_URL='http://127.0.0.1:3010'`.
