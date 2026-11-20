package gistdb

import (
	"context"
	"encoding/json"
)

// KV provides Redis-like operations against a gist-db KV database.
type KV struct {
	client *Client
	db     string
}

func (k *KV) cmd(ctx context.Context, op string, args []interface{}, params map[string]interface{}, out interface{}) error {
	req := Request{Mode: "kv", DB: k.db, Op: op, Args: args, Params: params}
	return k.client.CommandInto(ctx, req, out)
}

// Get returns the value for a key. found=false if missing/null.
func (k *KV) Get(ctx context.Context, key string) (json.RawMessage, bool, error) {
	raw, err := k.client.Command(ctx, Request{Mode: "kv", DB: k.db, Op: "get", Args: []interface{}{key}})
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false, nil
	}
	return raw, true, nil
}

func (k *KV) Set(ctx context.Context, key string, value interface{}, opts map[string]interface{}) (interface{}, error) {
	var out interface{}
	err := k.cmd(ctx, "set", []interface{}{key, value}, opts, &out)
	return out, err
}

func (k *KV) Del(ctx context.Context, keys ...string) (int, error) {
	args := make([]interface{}, 0, len(keys))
	for _, kx := range keys {
		args = append(args, kx)
	}
	var out int
	err := k.cmd(ctx, "del", args, nil, &out)
	return out, err
}

func (k *KV) Exists(ctx context.Context, keys ...string) (int, error) {
	args := make([]interface{}, 0, len(keys))
	for _, kx := range keys {
		args = append(args, kx)
	}
	var out int
	err := k.cmd(ctx, "exists", args, nil, &out)
	return out, err
}

func (k *KV) Incr(ctx context.Context, key string) (float64, error) {
	var out float64
	err := k.cmd(ctx, "incr", []interface{}{key}, nil, &out)
	return out, err
}

func (k *KV) IncrBy(ctx context.Context, key string, delta interface{}) (float64, error) {
	var out float64
	err := k.cmd(ctx, "incrby", []interface{}{key, delta}, nil, &out)
	return out, err
}

func (k *KV) Keys(ctx context.Context, pattern string) ([]string, error) {
	if pattern == "" {
		pattern = "*"
	}
	var out []string
	err := k.cmd(ctx, "keys", []interface{}{pattern}, nil, &out)
	return out, err
}

func (k *KV) HSet(ctx context.Context, key, field string, value interface{}) (int, error) {
	var out int
	err := k.cmd(ctx, "hset", []interface{}{key, field, value}, nil, &out)
	return out, err
}

func (k *KV) HGet(ctx context.Context, key, field string) (json.RawMessage, bool, error) {
	raw, err := k.client.Command(ctx, Request{Mode: "kv", DB: k.db, Op: "hget", Args: []interface{}{key, field}})
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false, nil
	}
	return raw, true, nil
}

func (k *KV) HGetAll(ctx context.Context, key string) (map[string]json.RawMessage, error) {
	raw, err := k.client.Command(ctx, Request{Mode: "kv", DB: k.db, Op: "hgetall", Args: []interface{}{key}})
	if err != nil {
		return nil, err
	}
	out := map[string]json.RawMessage{}
	if len(raw) == 0 || string(raw) == "null" {
		return out, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (k *KV) HDel(ctx context.Context, key string, fields ...string) (int, error) {
	args := []interface{}{key}
	for _, f := range fields {
		args = append(args, f)
	}
	var out int
	err := k.cmd(ctx, "hdel", args, nil, &out)
	return out, err
}

func (k *KV) LPush(ctx context.Context, key string, values ...interface{}) (int, error) {
	args := []interface{}{key}
	args = append(args, values...)
	var out int
	err := k.cmd(ctx, "lpush", args, nil, &out)
	return out, err
}

func (k *KV) RPush(ctx context.Context, key string, values ...interface{}) (int, error) {
	args := []interface{}{key}
	args = append(args, values...)
	var out int
	err := k.cmd(ctx, "rpush", args, nil, &out)
	return out, err
}

func (k *KV) LRange(ctx context.Context, key string, start, stop int) ([]json.RawMessage, error) {
	raw, err := k.client.Command(ctx, Request{Mode: "kv", DB: k.db, Op: "lrange", Args: []interface{}{key, start, stop}})
	if err != nil {
		return nil, err
	}
	var out []json.RawMessage
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (k *KV) Expire(ctx context.Context, key string, seconds int) (int, error) {
	var out int
	err := k.cmd(ctx, "expire", []interface{}{key, seconds}, nil, &out)
	return out, err
}

func (k *KV) TTL(ctx context.Context, key string) (int, error) {
	var out int
	err := k.cmd(ctx, "ttl", []interface{}{key}, nil, &out)
	return out, err
}

func (k *KV) DBSize(ctx context.Context) (int, error) {
	var out int
	err := k.cmd(ctx, "dbsize", nil, nil, &out)
	return out, err
}

func (k *KV) FlushDB(ctx context.Context) (string, error) {
	var out string
	err := k.cmd(ctx, "flushdb", nil, nil, &out)
	return out, err
}

func (k *KV) Refresh(ctx context.Context) (interface{}, error) {
	var out interface{}
	err := k.cmd(ctx, "refresh", nil, nil, &out)
	return out, err
}

// Raw executes an arbitrary KV op.
func (k *KV) Raw(ctx context.Context, op string, args []interface{}, params map[string]interface{}) (json.RawMessage, error) {
	return k.client.Command(ctx, Request{Mode: "kv", DB: k.db, Op: op, Args: args, Params: params})
}
