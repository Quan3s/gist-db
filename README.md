# gist_db

`gist_db` là database kiểu mới dùng **GitHub Gist** làm storage backend, với 2 chế độ lưu trữ:

1. **Table mode (giống PostgreSQL, lưu dạng bảng)**: bảng, cột, schema cơ bản, CRUD, truy vấn `where/orderBy/limit`, và parser SQL tối giản.
2. **Key/Value mode (giống Redis)**: `get/set/del/exists/keys/incr/hset/lpush/sadd/expire/...` lưu trên document JSON.

Ngoài thư viện Node.js, `gist_db` còn có:
- **CLI** (`gistdb`)
- **Server REST + TCP** kết nối qua URL (giống SQL/Redis)
- **Gói Go (`gistdb-go`)** để kết nối server

## Điểm chính: đọc qua RAW, không đọc nội dung qua GitHub API

- **READ (đọc dữ liệu)**: dùng **raw URL** (`https://gist.githubusercontent.com/.../raw/...`) để tải nội dung file trong gist.
  - Mục tiêu: tránh bị giới hạn/rate-limit của GitHub REST API khi đọc dữ liệu.
  - Thư viện/server giữ **local index** (`.gistdb-index.json`) ánh xạ `db name -> gistId/owner/rawUrl` để đọc raw mà không cần gọi API lấy nội dung.
- **WRITE (ghi/tạo/cập nhật/xóa)**: dùng **GitHub REST API** (`POST/PATCH/DELETE /gists`) vì raw URL không hỗ trợ ghi.
  - Cần `GITHUB_TOKEN` (Personal Access Token có scope `gist`).

> Lần tạo DB/gist đầu tiên và các thao tác ghi sẽ gọi API. Các lần đọc dữ liệu dùng raw URL.

## Kiến trúc lưu trữ

- Mỗi "database" là **một Gist**.
- **KV mode**: gist chứa file `kv.json` (`{ v, type:"kv", data:{ [key]:{value,type,expireAt} }, meta }`).
- **Table mode**: gist chứa `_manifest.json` (danh sách bảng) và `<table>.table.json` cho từng bảng (`{ schema, rows, sequences, meta }`).
- Local index mặc định: `.gistdb-index.json`.

## Yêu cầu

- Node.js >= 18 (server/CLI/lib dùng `fetch` built-in).
- Không phụ thuộc package npm ngoài.
- Biến môi trường (khuyến nghị cho ghi/local mode):
  - `GITHUB_TOKEN` hoặc `GIST_TOKEN` (scope `gist`)
  - `GITHUB_USER` hoặc `GIST_OWNER`
  - `GISTDB_INDEX_PATH` (tuỳ chọn)
  - `GISTDB_AUTH` (tuỳ chọn, shared secret bảo vệ server)

---

## 1) Thư viện Node.js

```js
const { createGistDB } = require('./gist_db');

(async () => {
  const db = createGistDB({
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_USER,
    indexPath: './.gistdb-index.json',
    cacheBust: true,
  });

  // KV (Redis-like)
  const kv = db.kv('myapp-kv');
  await kv.init();
  await kv.set('hello', 'world');
  await kv.incr('counter');
  await kv.hset('user:1', 'name', 'Alice');
  console.log(await kv.get('hello'));

  // Table (PostgreSQL-like)
  const tdb = db.table('myapp-db');
  await tdb.init();
  await tdb.createTable('users', [
    { name: 'id', type: 'serial', primaryKey: true },
    { name: 'email', type: 'text', unique: true, notNull: true },
    { name: 'name', type: 'text' },
  ], { ifNotExists: true });
  await tdb.insert('users', { email: 'a@example.com', name: 'Alice' });
  console.log(await tdb.select('users', { where: { name: 'Alice' } }));
  console.log(await tdb.query("SELECT * FROM users ORDER BY id DESC LIMIT 10"));
})();
```

### API tóm tắt

- **KV**: `set/get/del/exists/type/keys/mget/mset/incr/decr/incrby/append/strlen`, hash (`hset/hget/hgetall/hdel/hexists/hkeys/hvals`), list (`lpush/rpush/lrange/llen`), set (`sadd/smembers/srem`), expiry/misc (`expire/ttl/persistKey/dbsize/flushdb/info/refresh`)
- **Table**: `createTable/dropTable/listTables/describe/truncate`, `insert/insertMany/select/findOne/findById/count/update/delete`, `query(sql)` với SQL subset (`SHOW TABLES`, `DESCRIBE`, `CREATE/DROP/TRUNCATE`, `INSERT`, `SELECT ... WHERE ... ORDER BY ... LIMIT/OFFSET`, `UPDATE ... SET ... WHERE`, `DELETE ... WHERE`; WHERE cơ bản: `= != <> > >= < <= LIKE IN`, `AND`)

---

## 2) Server REST + TCP (kết nối qua URL giống SQL/Redis)

Server cho phép nhiều client kết nối và thao tác DB qua URL, hỗ trợ các protocol: **REST/HTTP**, **TCP JSONL**, **Redis RESP** (tương thích `redis-cli`), và **PostgreSQL wire protocol** (tương thích `psql` cơ bản).

### Chạy server

```bash
# từ repo root
node gist_db/bin/gistdb.js server --http-port 3010 --tcp-port 3011 --redis-port 6379 --pg-port 5432

# hoặc
GITHUB_TOKEN=... GITHUB_USER=... node gist_db/server/index.js --http-port 3010 --tcp-port 3011 --redis-port 6379 --pg-port 5432
```

Tuỳ chọn: `--host`, `--http-port` (mặc định 3010, env `GISTDB_HTTP_PORT`/`PORT`), `--tcp-port` (mặc định 3011, env `GISTDB_TCP_PORT`), `--redis-port` (mặc định 6379, env `GISTDB_REDIS_PORT`), `--pg-port` (mặc định 5432, env `GISTDB_PG_PORT`), `--auth <secret>` (`GISTDB_AUTH`), `--token`, `--owner`, `--index-path`, `--no-http`, `--no-tcp`, `--no-redis`, `--no-pg`.

### URL & giao thức

- **TCP (JSON-line)**: `gistdb://[auth@]host:3011[/db]?mode=kv|table`
  - Mỗi request là 1 dòng JSON, mỗi response là 1 dòng JSON.
  - Request: `{"id":1,"mode":"kv","db":"mykv","op":"get","args":["key"]}`
  - Response: `{"id":1,"ok":true,"result":"..."}` hoặc `{"id":1,"ok":false,"error":"..."}`
  - Ops đặc biệt: `ping` -> `PONG`, `info`, `use` (`{"op":"use","db":"mykv","mode":"kv"}`), `auth`
- **REST (HTTP JSON)**: `http://host:3010`
  - `GET /health`
  - `POST /v1/command` với body `{ "mode":"kv|table", "db":"...", "op":"...", "args":[...], "params":{...}, "sql":"..." }`
  - `POST /v1/kv/:db/:op` body `{ "args": [...], "params": {...} }`
  - `POST /v1/table/:db/query` body `{ "sql": "SELECT ..." }`
  - `POST /v1/table/:db/:op` (select/insert/update/delete/createTable/listTables/...)
  - Auth (nếu bật): header `Authorization: Bearer <secret>` hoặc `X-GistDB-Auth`
- **Redis RESP protocol** (KV mode): `redis://host:6379` (tương thích `redis-cli`)
  - Hỗ trợ các lệnh phổ biến: `PING`, `ECHO`, `AUTH`, `SELECT/USE`, `SET/GET/DEL/EXISTS/KEYS/TYPE/MGET/MSET/INCR/DECR/INCRBY/APPEND/STRLEN/EXPIRE/TTL/PERSIST/DBSIZE/FLUSHDB`, hash (`HSET/HMSET/HGET/HGETALL/HDEL/HEXISTS/HKEYS/HVALS`), list (`LPUSH/RPUSH/LRANGE/LLEN`), set (`SADD/SMEMBERS/SREM/SCARD`), `INFO/COMMAND/QUIT/HELLO`.
  - Dùng với `redis-cli -h 127.0.0.1 -p 6379` (db logic có thể chọn qua `SELECT <name>`/`USE <name>`).
- **PostgreSQL wire protocol v3** (Table/SQL mode, subset): `postgresql://host:5432/<db>` (tương thích `psql` cơ bản)
  - Hỗ trợ startup/auth cơ bản (trust hoặc cleartext password khi bật `--auth`), Simple Query protocol, trả về kết quả dạng bảng/command tag cho các câu SQL mà engine hỗ trợ (`SELECT/INSERT/UPDATE/DELETE/CREATE TABLE/DROP TABLE/SHOW TABLES/...`).
  - Dùng với `psql -h 127.0.0.1 -p 5432 -d mydb` (với server không bật auth).

Ví dụ REST:

```bash
curl -s http://127.0.0.1:3010/health

curl -s -X POST http://127.0.0.1:3010/v1/command \
  -H 'Content-Type: application/json' \
  -d '{"mode":"kv","db":"mykv","op":"set","args":["hello","world"]}'

curl -s -X POST http://127.0.0.1:3010/v1/table/mydb/query \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SHOW TABLES"}'
```

Ví dụ TCP (netcat / JSONL): gửi từng dòng JSON tới `127.0.0.1:3011`, ví dụ `{"id":1,"op":"ping"}`.

Ví dụ Redis protocol:

```bash
redis-cli -h 127.0.0.1 -p 6379 PING
redis-cli -h 127.0.0.1 -p 6379 SET hello world
redis-cli -h 127.0.0.1 -p 6379 GET hello
```

Ví dụ PostgreSQL protocol:

```bash
psql "host=127.0.0.1 port=5432 dbname=mydb sslmode=disable" -c "SELECT * FROM users"
psql "host=127.0.0.1 port=5432 dbname=mydb sslmode=disable" -c "SHOW TABLES"
```

---

## 3) CLI

```bash
node gist_db/bin/gistdb.js --help

# server
node gist_db/bin/gistdb.js server --http-port 3010 --tcp-port 3011

# kết nối qua URL (TCP, giống redis)
node gist_db/bin/gistdb.js -u gistdb://127.0.0.1:3011/mykv --mode kv kv set hello world
node gist_db/bin/gistdb.js -u gistdb://127.0.0.1:3011/mykv kv get hello
node gist_db/bin/gistdb.js -u gistdb://127.0.0.1:3011/mykv ping

# kết nối qua URL (REST)
node gist_db/bin/gistdb.js -u http://127.0.0.1:3010 --db mydb sql "SELECT * FROM users"
node gist_db/bin/gistdb.js -u http://127.0.0.1:3010 --db mydb table listTables

# local mode trực tiếp (không server, cần GITHUB_TOKEN/GITHUB_USER)
node gist_db/bin/gistdb.js --db mykv kv set hello world
node gist_db/bin/gistdb.js --db mydb sql "SHOW TABLES"
```

Lệnh chính: `server`, `kv <op> [args...]`, `table <op> [args...]`, `sql "<SQL>"`, `ping`, `info`.
Tuỳ chọn: `--url/-u`, `--db`, `--mode`, `--token`, `--owner`, `--index-path`, `--auth`, `--format <table|redis|json|raw>`, `--json`, `--raw`.

- `--format table` (psql-like): in bảng dạng PostgreSQL `psql` cho kết quả dạng hàng/cột và command tag (INSERT/UPDATE/DELETE/CREATE TABLE...) khi phù hợp.
- `--format redis`: in kết quả kiểu `redis-cli` (`OK`, `(integer) N`, `(nil)`, mảng đánh số...).
- Mặc định: `kv`/`ping` -> `redis`, `table`/`sql` -> `table` (trừ khi chỉ định `--format/--json/--raw`).

---

## 4) Gói Go kết nối (`gistdb-go`)

Source: `gist_db/go/gistdb` (module `github.com/vsphone/gistdb-go/gistdb`), ví dụ: `gist_db/go/example`.

- Kết nối qua URL: `gistdb://host:3011/db?mode=kv|table` (TCP JSONL) hoặc `http(s)://host:3010` (REST)
- API kiểu Redis/SQL: `Open`, `KV(db)`, `Table(db)`, `Query(sql)`, ...

```go
ctx := context.Background()
client, _ := gistdb.Open("gistdb://127.0.0.1:3011/mykv?mode=kv")
defer client.Close()

kv := client.KV("mykv")
_, _ = kv.Set(ctx, "hello", "world", nil)
val, ok, _ := kv.Get(ctx, "hello")

tdb := client.Table("mydb")
rows, _ := tdb.Query(ctx, "SELECT * FROM users WHERE age >= 18")
```

Chi tiết: xem `gist_db/go/gistdb/README.md` và `gist_db/go/example/`.

---

## Lưu ý & giới hạn

- **Không phải ACID/transactional DB**: ghi là read-modify-write + PATCH gist (last-write-wins), concurrent writers có thể ghi đè nhau.
- **Raw cache**: CDN có thể cache raw; mặc định `cacheBust=true` để giảm stale read.
- **Kích thước**: phù hợp dữ liệu nhỏ/vừa (config, metadata, prototype), không thay thế Postgres/Redis thật cho workload lớn.
- **Bảo mật**: bảo vệ `GITHUB_TOKEN` và `GISTDB_AUTH`; cân nhắc gitignore `.gistdb-index.json` nếu cần (đã có `gist_db/.gitignore`).
- **Protocol**: TCP dùng JSON-line protocol tự định nghĩa qua URL `gistdb://...`; REST dùng HTTP+JSON qua URL `http(s)://...`; có thêm Redis RESP (`redis://`, tương thích `redis-cli`, KV) và PostgreSQL wire protocol v3 subset (`postgresql://`, tương thích `psql`, SQL/table). Các protocol chuẩn (Redis/PG) được hỗ trợ ở mức tương thích thực dụng/subset (các lệnh/câu lệnh và luồng cơ bản), không đảm bảo tương đương 100% với toàn bộ tính năng/edge-case của Redis/PostgreSQL thật.

## Ví dụ Node

- `examples/kv-demo.js`, `examples/table-demo.js` (cần `GITHUB_TOKEN`, `GITHUB_USER`)
- `examples/local-api-shape-demo.js` (không cần mạng)
