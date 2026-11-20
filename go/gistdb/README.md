# gistdb Go client (`gistdb`)

Go package để kết nối tới **gist-db server** qua URL, hỗ trợ cả **TCP (JSON-line)** và **REST (HTTP)** — kiểu kết nối tương tự SQL/Redis DSN.

## URL kết nối

- `gistdb://[auth@]host:port[/db]?mode=kv|table` — TCP JSONL protocol (giống Redis: kết nối TCP qua URL)
- `tcp://host:port[/db]?mode=kv|table` — alias TCP
- `http://host:port` / `https://host:port` — REST API
- Query params: `mode=kv|table`, `db=<name>`, `auth=<secret>`

Ví dụ: `gistdb://127.0.0.1:3011/mykv?mode=kv`, `http://127.0.0.1:3010`

## Cài đặt / dùng trong module

```bash
# trong dự án Go của bạn
go get github.com/vsphone/gistdb-go/gistdb
```

Nếu dùng source trong repo này, có thể dùng `replace` trong `go.mod`:

```go
require github.com/vsphone/gistdb-go/gistdb v0.0.0
replace github.com/vsphone/gistdb-go/gistdb => ../path/to/gist_db/go/gistdb
```

## Sử dụng

```go
package main

import (
    "context"
    "fmt"

    "github.com/vsphone/gistdb-go/gistdb"
)

func main() {
    ctx := context.Background()

    // TCP URL (JSONL)
    client, err := gistdb.Open("gistdb://127.0.0.1:3011/mykv?mode=kv")
    if err != nil { panic(err) }
    defer client.Close()

    // KV (Redis-like)
    kv := client.KV("mykv")
    _, _ = kv.Set(ctx, "hello", "world", nil)
    val, ok, _ := kv.Get(ctx, "hello")
    fmt.Println(string(val), ok)
    n, _ := kv.Incr(ctx, "counter")
    fmt.Println(n)

    // Table (PostgreSQL-like / SQL)
    tdb := client.Table("mydb")
    rows, _ := tdb.Query(ctx, "SELECT * FROM users WHERE age >= 18 ORDER BY id DESC LIMIT 10")
    fmt.Println(string(rows))

    _, _ = tdb.Insert(ctx, "users", map[string]any{"email": "a@b.com", "name": "A"})
}
```

Kết nối qua REST chỉ cần đổi URL: `gistdb.Open("http://127.0.0.1:3010")` (API giống nhau, khác transport).

## API chính

- `gistdb.Open(dsn) (*Client, error)`, `client.Close()`, `client.Ping(ctx)`
- `client.Command(ctx, Request) (json.RawMessage, error)` / `CommandInto`
- `client.KV(db)`: `Get`, `Set`, `Del`, `Exists`, `Incr`, `IncrBy`, `Keys`, `HSet/HGet/HGetAll/HDel`, `LPush/RPush/LRange`, `Expire/TTL`, `DBSize`, `Raw`
- `client.Table(db)`: `Query/QueryInto` (SQL subset), `ListTables`, `Describe`, `CreateTable`, `DropTable`, `Insert/InsertMany`, `Select/SelectInto`, `FindByID`, `Update`, `Delete`, `Count`, `Truncate`, `Raw`

## Ghi chú

- Client TCP dùng protocol JSON-line của gist-db server: mỗi request/response là 1 dòng JSON.
- `Get/HGet` trả `(json.RawMessage, found, error)` để phân biệt missing/null.
- Server gist-db đọc dữ liệu qua gist raw URL và ghi qua GitHub API (cấu hình phía server).
