package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

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
  --format <fmt>       Output format: table (psql), redis, json, raw
  --json               Alias for --format json
  --raw                Alias for --format raw

Examples:
  gistdb ping --url gistdb://127.0.0.1:3011
  gistdb kv set hello world --url gistdb://127.0.0.1:3011/mykv --mode kv
  gistdb kv get hello --url http://127.0.0.1:3010 --db mykv
  gistdb sql "SELECT * FROM users" --url http://127.0.0.1:3010 --db mydb --format table
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
	format := fs.String("format", "", "output format: table|redis|json|raw")
	jsonFlag := fs.Bool("json", false, "output json")
	rawFlag := fs.Bool("raw", false, "output raw")
	flagArgs, rest := extractArgs(argv)
	if err := fs.Parse(flagArgs); err != nil {
		os.Exit(1)
	}
	fmtMode := resolveFormat(*format, *jsonFlag, *rawFlag, cmd)

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
		if fmtMode == "json" {
			fmt.Println(`"PONG"`)
		} else if fmtMode == "raw" {
			fmt.Println("PONG")
		} else {
			fmt.Println("PONG")
		}
		return
	case "info":
		raw, err := client.Command(ctx, gistdb.Request{Op: "info", DB: *db, Mode: *mode})
		if err != nil {
			fatal(err)
		}
		writeFormatted(raw, fmtMode, "info", "")
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
		writeFormatted(raw, fmtModeOr(fmtMode, "table"), "query", sqlStr)
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
		writeFormatted(raw, fmtModeOr(fmtMode, "redis"), rest[0], "")
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
		writeFormatted(raw, fmtModeOr(fmtMode, "table"), rest[0], "")
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

// extractArgs separates known flags from positional args, allowing flags to appear before or after positional arguments.
func extractArgs(argv []string) (flagArgs []string, positional []string) {
	known := map[string]bool{
		"--url": true, "--db": true, "--mode": true, "--timeout": true, "--format": true,
	}
	boolFlags := map[string]bool{"--json": true, "--raw": true}
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
		if boolFlags[name] {
			flagArgs = append(flagArgs, name)
			i++
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

func resolveFormat(format string, jsonFlag, rawFlag bool, cmd string) string {
	if jsonFlag {
		return "json"
	}
	if rawFlag {
		return "raw"
	}
	if format != "" {
		return strings.ToLower(format)
	}
	// defaults by command
	switch cmd {
	case "kv":
		return "redis"
	case "sql", "table":
		return "table"
	case "ping":
		return "redis"
	default:
		return "json"
	}
}

func fmtModeOr(current, def string) string {
	if current == "" || current == "json" {
		// if user explicitly chose json keep it; but here current is resolved already - check logic in caller
	}
	return current
}

func writeFormatted(raw json.RawMessage, format, op, sql string) {
	if len(raw) == 0 {
		fmt.Println("null")
		return
	}
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		fmt.Println(string(raw))
		return
	}
	switch strings.ToLower(format) {
	case "raw":
		if s, ok := v.(string); ok {
			fmt.Println(s)
		} else {
			b, _ := json.Marshal(v)
			fmt.Println(string(b))
		}
	case "redis", "resp":
		fmt.Print(formatRedis(v))
	case "table", "psql", "postgres", "pg":
		fmt.Print(formatPsql(v, op, sql))
	default:
		out, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			fmt.Println(string(raw))
			return
		}
		fmt.Println(string(out))
	}
}

func isPlainMap(v interface{}) (map[string]interface{}, bool) {
	m, ok := v.(map[string]interface{})
	return m, ok
}

func toRows(v interface{}) ([]map[string]interface{}, bool) {
	arr, ok := v.([]interface{})
	if !ok {
		return nil, false
	}
	rows := make([]map[string]interface{}, 0, len(arr))
	for _, it := range arr {
		if m, ok := isPlainMap(it); ok {
			rows = append(rows, m)
		} else {
			// primitive array element
			rows = append(rows, map[string]interface{}{"value": it})
		}
	}
	return rows, true
}

func cellString(v interface{}) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		// json numbers decode as float64
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		b, err := json.Marshal(x)
		if err != nil {
			return fmt.Sprint(x)
		}
		return string(b)
	}
}

func formatPsql(v interface{}, op, sql string) string {
	lop := strings.ToLower(op)
	lsql := strings.TrimSpace(sql)
	// numbers
	switch n := v.(type) {
	case float64:
		ni := int64(n)
		if strings.HasPrefix(strings.ToUpper(lsql), "INSERT") || lop == "insert" {
			val := ni
			if val == 0 {
				val = 0
			} else {
				val = 1
			}
			return fmt.Sprintf("INSERT 0 %d\n", val)
		}
		if strings.HasPrefix(strings.ToUpper(lsql), "UPDATE") || lop == "update" {
			return fmt.Sprintf("UPDATE %d\n", ni)
		}
		if strings.HasPrefix(strings.ToUpper(lsql), "DELETE") || lop == "delete" {
			return fmt.Sprintf("DELETE %d\n", ni)
		}
		if strings.HasPrefix(strings.ToUpper(lsql), "TRUNCATE") || lop == "truncate" {
			return "TRUNCATE TABLE\n"
		}
		if lop == "count" {
			return formatPsqlTable([]map[string]interface{}{{"count": n}}, nil)
		}
		return formatPsqlTable([]map[string]interface{}{{"result": n}}, nil)
	case bool:
		if strings.HasPrefix(strings.ToUpper(lsql), "DROP") || lop == "droptable" {
			return "DROP TABLE\n"
		}
		if n {
			return "t\n"
		}
		return "f\n"
	case string:
		if n == "OK" {
			return "OK\n"
		}
		if n == "PONG" {
			return "PONG\n"
		}
		if strings.HasPrefix(strings.ToUpper(lsql), "CREATE TABLE") || lop == "createtable" {
			return "CREATE TABLE\n"
		}
		if strings.HasPrefix(strings.ToUpper(lsql), "DROP TABLE") || lop == "droptable" {
			return "DROP TABLE\n"
		}
		return n + "\n"
	case nil:
		return "(0 rows)\n"
	}

	if rows, ok := toRows(v); ok {
		return formatPsqlTable(rows, nil)
	}
	if m, ok := isPlainMap(v); ok {
		if cols, ok := m["columns"].([]interface{}); ok {
			schemaRows := make([]map[string]interface{}, 0, len(cols))
			for _, c := range cols {
				cm, _ := c.(map[string]interface{})
				tname, _ := cm["type"].(string)
				if pk, _ := cm["primaryKey"].(bool); pk {
					tname += " (PK)"
				}
				notNull := ""
				if nn, _ := cm["notNull"].(bool); nn {
					notNull = "not null"
				}
				uniq := ""
				if u, _ := cm["unique"].(bool); u {
					uniq = "yes"
				}
				def := ""
				if d, ok := cm["default"]; ok && d != nil {
					def = cellString(d)
				}
				schemaRows = append(schemaRows, map[string]interface{}{
					"Column": cellString(cm["name"]), "Type": tname, "Nullable": notNull, "Default": def, "Unique": uniq,
				})
			}
			out := formatPsqlTable(schemaRows, []string{"Column", "Type", "Nullable", "Default", "Unique"})
			if pk, ok := m["primaryKey"].(string); ok && pk != "" {
				out = "Table schema (pk: " + pk + ")\n" + out
			}
			return out
		}
		if lop == "insert" || lop == "findone" || lop == "findbyid" {
			return formatPsqlTable([]map[string]interface{}{m}, nil)
		}
		// generic object as key/value
		kvrows := []map[string]interface{}{}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			val := m[k]
			s := ""
			if str, ok := val.(string); ok {
				s = str
			} else {
				b, _ := json.Marshal(val)
				s = string(b)
			}
			kvrows = append(kvrows, map[string]interface{}{"key": k, "value": s})
		}
		return formatPsqlTable(kvrows, []string{"key", "value"})
	}
	out, _ := json.MarshalIndent(v, "", "  ")
	return string(out) + "\n"
}

func formatPsqlTable(rows []map[string]interface{}, orderedCols []string) string {
	if len(rows) == 0 {
		if len(orderedCols) == 0 {
			return "(0 rows)\n"
		}
		widths := make([]int, len(orderedCols))
		for i, c := range orderedCols {
			widths[i] = utf8.RuneCountInString(c)
		}
		header := " " + joinPadded(orderedCols, widths, nil) + " "
		sep := "-" + joinSep(widths) + "-"
		return header + "\n" + sep + "\n(0 rows)\n"
	}
	cols := orderedCols
	if len(cols) == 0 {
		seen := map[string]bool{}
		for _, r := range rows {
			for k := range r {
				if !seen[k] {
					seen[k] = true
					cols = append(cols, k)
				}
			}
		}
	}
	widths := make([]int, len(cols))
	for i, c := range cols {
		widths[i] = utf8.RuneCountInString(c)
	}
	strRows := make([][]string, len(rows))
	for ri, r := range rows {
		sr := make([]string, len(cols))
		for i, c := range cols {
			sr[i] = cellString(r[c])
			if l := utf8.RuneCountInString(sr[i]); l > widths[i] {
				widths[i] = l
			}
		}
		strRows[ri] = sr
	}
	right := make([]bool, len(cols))
	for i := range cols {
		allNum := true
		for _, sr := range strRows {
			if sr[i] == "" {
				continue
			}
			if _, err := strconv.ParseFloat(sr[i], 64); err != nil {
				allNum = false
				break
			}
		}
		right[i] = allNum
	}
	header := " " + joinPadded(cols, widths, rightPadArr(len(cols))) + " "
	sep := "-" + joinSep(widths) + "-"
	lines := []string{header, sep}
	for _, sr := range strRows {
		lines = append(lines, " "+joinPadded(sr, widths, right)+" ")
	}
	suf := "rows"
	if len(rows) == 1 {
		suf = "row"
	}
	lines = append(lines, fmt.Sprintf("(%d %s)", len(rows), suf))
	return strings.Join(lines, "\n") + "\n"
}

func rightPadArr(n int) []bool { b := make([]bool, n); return b }

func joinPadded(cells []string, widths []int, right []bool) string {
	parts := make([]string, len(cells))
	for i, c := range cells {
		w := widths[i]
		pad := w - utf8.RuneCountInString(c)
		if pad < 0 {
			pad = 0
		}
		if right != nil && right[i] {
			parts[i] = strings.Repeat(" ", pad) + c
		} else {
			parts[i] = c + strings.Repeat(" ", pad)
		}
	}
	return strings.Join(parts, " | ")
}

func joinSep(widths []int) string {
	parts := make([]string, len(widths))
	for i, w := range widths {
		if w < 0 {
			w = 0
		}
		parts[i] = strings.Repeat("-", w)
	}
	return strings.Join(parts, "-+-")
}

func formatRedis(v interface{}) string {
	return formatRedisValue(v) + "\n"
}

func formatRedisValue(v interface{}) string {
	if v == nil {
		return "(nil)"
	}
	switch x := v.(type) {
	case bool:
		if x {
			return "(integer) 1"
		}
		return "(integer) 0"
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprintf("(integer) %d", int64(x))
		}
		return fmt.Sprintf("%v", x)
	case string:
		if x == "OK" || x == "PONG" {
			return x
		}
		b, _ := json.Marshal(x)
		return string(b)
	case []interface{}:
		if len(x) == 0 {
			return "(empty array)"
		}
		pad := len(strconv.Itoa(len(x)))
		lines := make([]string, 0, len(x))
		for i, it := range x {
			prefix := fmt.Sprintf("%*d) ", pad, i+1)
			inner := formatRedisValue(it)
			innerLines := strings.Split(inner, "\n")
			if len(innerLines) == 1 {
				lines = append(lines, prefix+innerLines[0])
			} else {
				indent := strings.Repeat(" ", len(prefix))
				lines = append(lines, prefix+innerLines[0])
				for _, l := range innerLines[1:] {
					lines = append(lines, indent+l)
				}
			}
		}
		return strings.Join(lines, "\n")
	case map[string]interface{}:
		if len(x) == 0 {
			return "(empty array)"
		}
		// preserve insertion not possible; sort keys for stability
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		flat := make([]interface{}, 0, len(keys)*2)
		for _, k := range keys {
			flat = append(flat, k, x[k])
		}
		return formatRedisValue(flat)
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "Error:", err)
	os.Exit(1)
}
