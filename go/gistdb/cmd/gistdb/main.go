package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/vsphone/gistdb-go/gistdb"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}
	cmd := os.Args[1]
	switch cmd {
	case "help", "-h", "--help":
		usage()
		return
	case "ping", "info", "kv", "table", "sql":
		runClient(cmd, os.Args[2:])
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", cmd)
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`gistdb-go client CLI

Usage:
  gistdb <command> [options] [args...]

Commands:
  ping                 Ping server (requires --url)
  info                 Get server info (requires --url)
  kv <op> [args...]    KV operation (get,set,del,exists,incr,incrby,keys,hset,hget,hgetall,hdel,lpush,rpush,lrange,expire,ttl,dbsize,mget,mset,...)
  table <op> [args...] Table operation (listTables,describe,createTable,dropTable,insert,insertMany,select,findOne,findById,update,delete,count,truncate,query)
  sql "<SQL>"          Run SQL via table.query (requires --url and --db)
  help                 Show help

Options:
  --url <url>          Connection URL (required for remote ops)
                       gistdb://host:3011[/db]?mode=kv|table  (TCP JSONL)
                       http(s)://host:3010                    (REST)
  --db <name>          Database/gist logical name
  --mode <kv|table>    Mode
  --timeout <sec>      Timeout seconds (default 60)

Examples:
  gistdb ping --url gistdb://127.0.0.1:3011
  gistdb kv set hello world --url gistdb://127.0.0.1:3011/mykv --mode kv
  gistdb kv get hello --url http://127.0.0.1:3010 --db mykv
  gistdb sql "SELECT * FROM users" --url http://127.0.0.1:3010 --db mydb
  gistdb table listTables --url http://127.0.0.1:3010 --db mydb
`)
}

func runClient(cmd string, argv []string) {
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	url := fs.String("url", os.Getenv("GISTDB_URL"), "connection URL")
	db := fs.String("db", os.Getenv("GISTDB_DB"), "database name")
	mode := fs.String("mode", os.Getenv("GISTDB_MODE"), "mode: kv|table")
	timeout := fs.Int("timeout", 60, "timeout seconds")
	flagArgs, rest := extractArgs(argv)
	if err := fs.Parse(flagArgs); err != nil {
		os.Exit(1)
	}

	if *url == "" {
		fatal(errors.New("--url is required (gistdb://... for TCP or http(s)://... for REST)"))
	}

	// Infer db/mode from URL when not explicitly provided.
	if *db == "" || *mode == "" {
		if ci, err := gistdb.ParseURL(*url); err == nil {
			if *db == "" {
				*db = ci.DB
			}
			if *mode == "" {
				*mode = ci.Mode
			}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*timeout)*time.Second)
	defer cancel()

	client, err := gistdb.Open(*url)
	if err != nil {
		fatal(err)
	}
	defer client.Close()

	switch cmd {
	case "ping":
		if err := client.Ping(ctx); err != nil {
			fatal(err)
		}
		fmt.Println("PONG")
		return
	case "info":
		raw, err := client.Command(ctx, gistdb.Request{Op: "info", DB: *db, Mode: *mode})
		if err != nil {
			fatal(err)
		}
		writeRaw(raw)
		return
	case "sql":
		if *db == "" {
			fatal(errors.New("--db is required for sql"))
		}
		sqlStr := strings.Join(rest, " ")
		if strings.TrimSpace(sqlStr) == "" {
			fatal(errors.New("SQL is required"))
		}
		raw, err := client.Command(ctx, gistdb.Request{Mode: "table", DB: *db, Op: "query", SQL: sqlStr})
		if err != nil {
			fatal(err)
		}
		writeRaw(raw)
		return
	case "kv":
		if len(rest) < 1 {
			fatal(errors.New("kv op required"))
		}
		if *db == "" {
			fatal(errors.New("--db is required for kv"))
		}
		raw, err := execKV(ctx, client, *db, rest[0], rest[1:])
		if err != nil {
			fatal(err)
		}
		writeRaw(raw)
		return
	case "table":
		if len(rest) < 1 {
			fatal(errors.New("table op required"))
		}
		if *db == "" {
			fatal(errors.New("--db is required for table"))
		}
		raw, err := execTable(ctx, client, *db, rest[0], rest[1:])
		if err != nil {
			fatal(err)
		}
		writeRaw(raw)
		return
	}
}

func execKV(ctx context.Context, client *gistdb.Client, db, op string, args []string) (json.RawMessage, error) {
	req := gistdb.Request{Mode: "kv", DB: db, Op: op}
	switch op {
	case "set":
		if len(args) < 2 {
			return nil, errors.New("kv set requires: <key> <value>")
		}
		req.Args = []interface{}{args[0], parseLoose(args[1])}
	case "mset":
		if len(args) < 1 {
			return nil, errors.New("kv mset requires JSON object arg")
		}
		var obj map[string]interface{}
		if err := json.Unmarshal([]byte(args[0]), &obj); err != nil {
			return nil, fmt.Errorf("mset arg must be JSON object: %w", err)
		}
		req.Params = obj
	case "hset":
		if len(args) < 3 {
			return nil, errors.New("kv hset requires: <key> <field> <value>")
		}
		req.Args = []interface{}{args[0], args[1], parseLoose(args[2])}
	default:
		vals := make([]interface{}, 0, len(args))
		for _, a := range args {
			vals = append(vals, parseLoose(a))
		}
		req.Args = vals
	}
	return client.Command(ctx, req)
}

func execTable(ctx context.Context, client *gistdb.Client, db, op string, args []string) (json.RawMessage, error) {
	req := gistdb.Request{Mode: "table", DB: db, Op: op}
	switch op {
	case "query", "sql":
		req.Op = "query"
		req.SQL = strings.Join(args, " ")
		if strings.TrimSpace(req.SQL) == "" {
			return nil, errors.New("sql required")
		}
	case "listTables", "showTables", "refreshManifest":
	case "describe", "truncate":
		if len(args) < 1 {
			return nil, fmt.Errorf("%s requires <table>", op)
		}
		req.Params = map[string]interface{}{"table": args[0]}
	case "dropTable":
		if len(args) < 1 {
			return nil, errors.New("dropTable requires <table>")
		}
		req.Params = map[string]interface{}{"table": args[0], "options": map[string]interface{}{}}
	case "createTable":
		if len(args) < 2 {
			return nil, errors.New("createTable requires <table> <columns-json>")
		}
		var cols interface{}
		if err := json.Unmarshal([]byte(args[1]), &cols); err != nil {
			return nil, fmt.Errorf("columns must be JSON: %w", err)
		}
		req.Params = map[string]interface{}{"table": args[0], "columns": cols}
	case "insert":
		if len(args) < 2 {
			return nil, errors.New("insert requires <table> <row-json>")
		}
		var row interface{}
		if err := json.Unmarshal([]byte(args[1]), &row); err != nil {
			return nil, fmt.Errorf("row must be JSON: %w", err)
		}
		req.Params = map[string]interface{}{"table": args[0], "row": row}
	case "insertMany":
		if len(args) < 2 {
			return nil, errors.New("insertMany requires <table> <rows-json-array>")
		}
		var rows interface{}
		if err := json.Unmarshal([]byte(args[1]), &rows); err != nil {
			return nil, fmt.Errorf("rows must be JSON array: %w", err)
		}
		req.Params = map[string]interface{}{"table": args[0], "rows": rows}
	case "select", "findOne":
		if len(args) < 1 {
			return nil, fmt.Errorf("%s requires <table> [query-json]", op)
		}
		q := map[string]interface{}{}
		if len(args) >= 2 {
			if err := json.Unmarshal([]byte(args[1]), &q); err != nil {
				return nil, fmt.Errorf("query must be JSON: %w", err)
			}
		}
		req.Params = map[string]interface{}{"table": args[0], "query": q}
	case "findById":
		if len(args) < 2 {
			return nil, errors.New("findById requires <table> <id>")
		}
		req.Params = map[string]interface{}{"table": args[0], "id": parseLoose(args[1])}
	case "update":
		if len(args) < 3 {
			return nil, errors.New("update requires <table> <where-json> <patch-json>")
		}
		var where, patch map[string]interface{}
		if err := json.Unmarshal([]byte(args[1]), &where); err != nil {
			return nil, fmt.Errorf("where must be JSON: %w", err)
		}
		if err := json.Unmarshal([]byte(args[2]), &patch); err != nil {
			return nil, fmt.Errorf("patch must be JSON: %w", err)
		}
		req.Params = map[string]interface{}{"table": args[0], "where": where, "patch": patch}
	case "delete":
		if len(args) < 2 {
			return nil, errors.New("delete requires <table> <where-json>")
		}
		var where map[string]interface{}
		if err := json.Unmarshal([]byte(args[1]), &where); err != nil {
			return nil, fmt.Errorf("where must be JSON: %w", err)
		}
		req.Params = map[string]interface{}{"table": args[0], "where": where}
	case "count":
		if len(args) < 1 {
			return nil, errors.New("count requires <table> [where-json]")
		}
		where := map[string]interface{}{}
		if len(args) >= 2 {
			if err := json.Unmarshal([]byte(args[1]), &where); err != nil {
				return nil, fmt.Errorf("where must be JSON: %w", err)
			}
		}
		req.Params = map[string]interface{}{"table": args[0], "where": where}
	default:
		if len(args) == 1 {
			var p map[string]interface{}
			if err := json.Unmarshal([]byte(args[0]), &p); err == nil {
				req.Params = p
			} else {
				req.Args = []interface{}{parseLoose(args[0])}
			}
		} else if len(args) > 1 {
			vals := make([]interface{}, 0, len(args))
			for _, a := range args {
				vals = append(vals, parseLoose(a))
			}
			req.Args = vals
		}
	}
	return client.Command(ctx, req)
}

// extractArgs separates known flags (--url, --db, --mode, --timeout) from positional args,
// allowing flags to appear before or after positional arguments.
func extractArgs(argv []string) (flagArgs []string, positional []string) {
	known := map[string]bool{"--url": true, "--db": true, "--mode": true, "--timeout": true}
	i := 0
	for i < len(argv) {
		a := argv[i]
		// normalize single-dash long flags: -url -> --url
		if strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && len(a) > 2 {
			a = "-" + a
		}
		name := a
		hasEq := false
		if strings.HasPrefix(a, "--") {
			if idx := strings.Index(a, "="); idx >= 0 {
				name = a[:idx]
				hasEq = true
			}
		}
		if known[name] {
			if hasEq {
				flagArgs = append(flagArgs, a)
				i++
			} else {
				flagArgs = append(flagArgs, name)
				if i+1 < len(argv) {
					flagArgs = append(flagArgs, argv[i+1])
					i += 2
				} else {
					i++
				}
			}
			continue
		}
		positional = append(positional, argv[i])
		i++
	}
	return
}

func parseLoose(s string) interface{} {
	switch s {
	case "null":
		return nil
	case "true":
		return true
	case "false":
		return false
	}
	if i, err := strconv.ParseInt(s, 10, 64); err == nil {
		return i
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		// prefer int if already returned, but ParseInt succeeded for ints; floats with dot
		if strings.ContainsAny(s, ".eE") {
			return f
		}
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil && strings.ContainsAny(s, ".eE") {
		return f
	}
	if (strings.HasPrefix(s, "{") && strings.HasSuffix(s, "}")) || (strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]")) {
		var v interface{}
		if err := json.Unmarshal([]byte(s), &v); err == nil {
			return v
		}
	}
	return s
}

func writeRaw(raw json.RawMessage) {
	if len(raw) == 0 {
		fmt.Println("null")
		return
	}
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		fmt.Println(string(raw))
		return
	}
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Println(string(raw))
		return
	}
	fmt.Println(string(out))
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "Error:", err)
	os.Exit(1)
}
