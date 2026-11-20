package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/vsphone/gistdb-go/gistdb"
)

func main() {
	// Example URLs:
	//   gistdb://127.0.0.1:3011/mykv?mode=kv      (TCP JSONL, like redis)
	//   http://127.0.0.1:3010                    (REST)
	dsn := os.Getenv("GISTDB_URL")
	if dsn == "" {
		dsn = "gistdb://127.0.0.1:3011/mykv?mode=kv"
	}
	dbName := os.Getenv("GISTDB_DB")
	if dbName == "" {
		dbName = "mykv"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client, err := gistdb.Open(dsn)
	if err != nil {
		panic(err)
	}
	defer client.Close()

	if err := client.Ping(ctx); err != nil {
		panic(err)
	}
	fmt.Println("connected:", dsn)

	// KV mode example (Redis-like)
	kv := client.KV(dbName)
	if _, err := kv.Set(ctx, "hello", "world", nil); err != nil {
		fmt.Println("kv set err:", err)
	} else {
		if v, ok, err := kv.Get(ctx, "hello"); err == nil && ok {
			fmt.Println("kv get hello =", string(v))
		}
	}
	if n, err := kv.Incr(ctx, "counter"); err == nil {
		fmt.Println("kv counter =", n)
	}

	// Table/SQL example (PostgreSQL-like)
	tableDB := os.Getenv("GISTDB_TABLE_DB")
	if tableDB == "" {
		tableDB = "mydb"
	}
	tdb := client.Table(tableDB)
	if rows, err := tdb.Query(ctx, "SHOW TABLES"); err == nil {
		fmt.Println("tables =", string(rows))
	} else {
		fmt.Println("query err:", err)
	}
}
