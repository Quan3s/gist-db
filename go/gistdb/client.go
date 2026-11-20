package gistdb

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Request is a generic gist-db command request.
type Request struct {
	ID     interface{}            `json:"id,omitempty"`
	Mode   string                 `json:"mode,omitempty"`
	DB     string                 `json:"db,omitempty"`
	Op     string                 `json:"op,omitempty"`
	Args   []interface{}          `json:"args,omitempty"`
	Params map[string]interface{} `json:"params,omitempty"`
	SQL    string                 `json:"sql,omitempty"`
	Table  string                 `json:"table,omitempty"`
	Where  interface{}            `json:"where,omitempty"`
	Query  interface{}            `json:"query,omitempty"`
	Row    interface{}            `json:"row,omitempty"`
	Rows   interface{}            `json:"rows,omitempty"`
	Patch  interface{}            `json:"patch,omitempty"`
	Auth   string                 `json:"auth,omitempty"`
	Token  string                 `json:"token,omitempty"`
}

// tcpResponse is the JSONL response envelope.
type tcpResponse struct {
	ID     interface{}     `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// httpResponse is the REST response envelope.
type httpResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// Client connects to a gist-db server over TCP (JSONL) or HTTP/REST.
type Client struct {
	conn      *ConnInfo
	defaultDB string
	mode      string

	mu       sync.Mutex
	netConn  net.Conn
	reader   *bufio.Reader
	seq      uint64
	closed   bool
	httpClient *http.Client
}

// Open connects to a gist-db server using a URL.
//   gistdb://host:port[/db]?mode=kv|table  -> TCP JSON-line protocol
//   http(s)://host:port                    -> REST API
func Open(dsn string) (*Client, error) {
	ci, err := ParseURL(dsn)
	if err != nil {
		return nil, err
	}
	c := &Client{conn: ci, defaultDB: ci.DB, mode: ci.Mode}
	if ci.IsHTTP() {
		c.httpClient = &http.Client{Timeout: 60 * time.Second}
		return c, nil
	}
	if err := c.dialTCP(context.Background()); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Client) dialTCP(ctx context.Context) error {
	d := net.Dialer{Timeout: 10 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", c.conn.Address())
	if err != nil {
		return err
	}
	c.netConn = conn
	c.reader = bufio.NewReader(conn)
	if c.conn.Auth != "" {
		if _, err := c.doTCP(ctx, Request{Op: "auth", Token: c.conn.Auth}); err != nil {
			_ = conn.Close()
			return fmt.Errorf("auth failed: %w", err)
		}
	}
	if c.defaultDB != "" || c.mode != "" {
		if _, err := c.doTCP(ctx, Request{Op: "use", DB: c.defaultDB, Mode: c.mode}); err != nil {
			_ = conn.Close()
			return fmt.Errorf("use failed: %w", err)
		}
	}
	return nil
}

// Close closes the client connection.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if c.netConn != nil {
		err := c.netConn.Close()
		c.netConn = nil
		return err
	}
	return nil
}

// Ping checks connectivity.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.Command(ctx, Request{Op: "ping"})
	return err
}

// Command sends a generic command and returns the raw JSON result.
func (c *Client) Command(ctx context.Context, req Request) (json.RawMessage, error) {
	if c.conn.IsHTTP() {
		return c.doHTTP(ctx, req)
	}
	return c.doTCP(ctx, req)
}

// CommandInto sends a command and unmarshals the result into out.
func (c *Client) CommandInto(ctx context.Context, req Request, out interface{}) error {
	raw, err := c.Command(ctx, req)
	if err != nil {
		return err
	}
	if out == nil || len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func (c *Client) doTCP(ctx context.Context, req Request) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.netConn == nil {
		return nil, errors.New("client is closed")
	}
	id := atomic.AddUint64(&c.seq, 1)
	req.ID = id
	if req.DB == "" {
		req.DB = c.defaultDB
	}
	if req.Mode == "" {
		req.Mode = c.mode
	}
	b, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	b = append(b, '\n')
	if dl, ok := ctx.Deadline(); ok {
		_ = c.netConn.SetDeadline(dl)
	} else {
		_ = c.netConn.SetDeadline(time.Now().Add(60 * time.Second))
	}
	if _, err := c.netConn.Write(b); err != nil {
		return nil, err
	}
	line, err := c.reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var resp tcpResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if !resp.OK {
		if resp.Error == "" {
			resp.Error = "unknown error"
		}
		return nil, errors.New(resp.Error)
	}
	return resp.Result, nil
}

func (c *Client) doHTTP(ctx context.Context, req Request) (json.RawMessage, error) {
	if req.DB == "" {
		req.DB = c.defaultDB
	}
	if req.Mode == "" {
		req.Mode = c.mode
	}
	b, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	endpoint := c.conn.BaseHTTP + "/v1/command"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.conn.Auth != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.conn.Auth)
	}
	hc := c.httpClient
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	var resp httpResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode http response: %w (%s)", err, string(body))
	}
	if res.StatusCode >= 400 || !resp.OK {
		if resp.Error == "" {
			resp.Error = fmt.Sprintf("http status %d", res.StatusCode)
		}
		return nil, errors.New(resp.Error)
	}
	return resp.Result, nil
}

// KV returns a KV-scoped helper bound to a database name.
func (c *Client) KV(db string) *KV {
	if db == "" {
		db = c.defaultDB
	}
	return &KV{client: c, db: db}
}

// Table returns a table/SQL-scoped helper bound to a database name.
func (c *Client) Table(db string) *TableDB {
	if db == "" {
		db = c.defaultDB
	}
	return &TableDB{client: c, db: db}
}
