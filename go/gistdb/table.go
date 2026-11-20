package gistdb

import (
	"context"
	"encoding/json"
)

// TableDB provides PostgreSQL-like table operations against a gist-db database.
type TableDB struct {
	client *Client
	db     string
}

// Query executes a SQL statement (subset supported by gist-db server).
func (t *TableDB) Query(ctx context.Context, sql string) (json.RawMessage, error) {
	return t.client.Command(ctx, Request{Mode: "table", DB: t.db, Op: "query", SQL: sql})
}

// QueryInto executes SQL and unmarshals the result into out.
func (t *TableDB) QueryInto(ctx context.Context, sql string, out interface{}) error {
	return t.client.CommandInto(ctx, Request{Mode: "table", DB: t.db, Op: "query", SQL: sql}, out)
}

func (t *TableDB) ListTables(ctx context.Context) ([]string, error) {
	var out []string
	err := t.client.CommandInto(ctx, Request{Mode: "table", DB: t.db, Op: "listTables"}, &out)
	return out, err
}

func (t *TableDB) Describe(ctx context.Context, table string) (json.RawMessage, error) {
	return t.client.Command(ctx, Request{Mode: "table", DB: t.db, Op: "describe", Params: map[string]interface{}{"table": table}})
}

func (t *TableDB) CreateTable(ctx context.Context, table string, columns interface{}, opts map[string]interface{}) (json.RawMessage, error) {
	params := map[string]interface{}{"table": table, "columns": columns}
	if opts != nil {
		params["options"] = opts
	}
	return t.client.Command(ctx, Request{Mode: "table", DB: t.db, Op: "createTable", Params: params})
}

func (t *TableDB) DropTable(ctx context.Context, table string, ifExists bool) (bool, error) {
	var out bool
	err := t.client.CommandInto(ctx, Request{Mode: "table", DB: t.db, Op: "dropTable", Params: map[string]interface{}{"table": table, "options": map[string]interface{}{"ifExists": ifExists}}}, &out)
	return out, err
}

func (t *TableDB) Insert(ctx context.Context, table string, row interface{}) (json.RawMessage, error) {
	return t.client.Command(ctx, Request{Mode: "table", DB: t.db, Op: "insert", Params: map[string]interface{}{"table": table, "row": row}})
}

func (t *TableDB) InsertMany(ctx context.Context, table string, rows interface{}) (json.RawMessage, error) {
	return t.client.Command(ctx, Request{Mode: "table", DB: t.db, Op: "insertMany", Params: map[string]interface{}{"table": table, "rows": rows}})
}

func (t *TableDB) Select(ctx context.Context, table string, query map[string]interface{}) (json.RawMessage, error) {
	return t.client.Command(ctx, Request{Mode: "table", DB: t.db, Op: "select", Params: map[string]interface{}{"table": table, "query": query}})
}

func (t *TableDB) SelectInto(ctx context.Context, table string, query map[string]interface{}, out interface{}) error {
	return t.client.CommandInto(ctx, Request{Mode: "table", DB: t.db, Op: "select", Params: map[string]interface{}{"table": table, "query": query}}, out)
}

func (t *TableDB) FindByID(ctx context.Context, table string, id interface{}) (json.RawMessage, error) {
	return t.client.Command(ctx, Request{Mode: "table", DB: t.db, Op: "findById", Params: map[string]interface{}{"table": table, "id": id}})
}

func (t *TableDB) Update(ctx context.Context, table string, where map[string]interface{}, patch map[string]interface{}) (int, error) {
	var out int
	err := t.client.CommandInto(ctx, Request{Mode: "table", DB: t.db, Op: "update", Params: map[string]interface{}{"table": table, "where": where, "patch": patch}}, &out)
	return out, err
}

func (t *TableDB) Delete(ctx context.Context, table string, where map[string]interface{}) (int, error) {
	var out int
	err := t.client.CommandInto(ctx, Request{Mode: "table", DB: t.db, Op: "delete", Params: map[string]interface{}{"table": table, "where": where}}, &out)
	return out, err
}

func (t *TableDB) Count(ctx context.Context, table string, where map[string]interface{}) (int, error) {
	var out int
	err := t.client.CommandInto(ctx, Request{Mode: "table", DB: t.db, Op: "count", Params: map[string]interface{}{"table": table, "where": where}}, &out)
	return out, err
}

func (t *TableDB) Truncate(ctx context.Context, table string) (int, error) {
	var out int
	err := t.client.CommandInto(ctx, Request{Mode: "table", DB: t.db, Op: "truncate", Params: map[string]interface{}{"table": table}}, &out)
	return out, err
}

// Raw executes an arbitrary table op.
func (t *TableDB) Raw(ctx context.Context, op string, params map[string]interface{}) (json.RawMessage, error) {
	return t.client.Command(ctx, Request{Mode: "table", DB: t.db, Op: op, Params: params})
}
