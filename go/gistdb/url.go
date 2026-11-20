package gistdb

import (
	"fmt"
	"net/url"
	"strings"
)

// ConnInfo holds parsed connection URL information.
// Supported URL forms:
//   - gistdb://[auth@]host:port[/db]?mode=kv|table&auth=secret  (TCP JSONL)
//   - tcp://host:port[/db]?mode=kv|table
//   - http://host:port[/base]?db=...&mode=...
//   - https://host:port[/base]?db=...&mode=...
type ConnInfo struct {
	Scheme   string
	Host     string
	Port     string
	Auth     string
	DB       string
	Mode     string
	RawURL   string
	BaseHTTP string
}

// ParseURL parses a gist-db connection URL.
func ParseURL(raw string) (*ConnInfo, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse url: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme == "" {
		return nil, fmt.Errorf("missing URL scheme")
	}
	ci := &ConnInfo{Scheme: scheme, RawURL: raw}
	ci.Host = u.Hostname()
	ci.Port = u.Port()
	q := u.Query()
	ci.Mode = q.Get("mode")
	ci.DB = q.Get("db")
	if ci.Auth == "" {
		ci.Auth = q.Get("auth")
	}
	if ci.Auth == "" {
		ci.Auth = q.Get("token")
	}
	if u.User != nil {
		if p, ok := u.User.Password(); ok {
			ci.Auth = p
		} else if u.User.Username() != "" {
			ci.Auth = u.User.Username()
		}
	}
	// path: /dbname (for tcp/gistdb) or base path (for http)
	path := strings.Trim(u.Path, "/")
	if path != "" && ci.DB == "" {
		parts := strings.SplitN(path, "/", 2)
		ci.DB = parts[0]
	}
	switch scheme {
	case "http", "https":
		if ci.Port == "" {
			if scheme == "https" {
				ci.Port = "443"
			} else {
				ci.Port = "80"
			}
		}
		ci.BaseHTTP = fmt.Sprintf("%s://%s", scheme, u.Host)
	case "gistdb", "tcp", "gistdb+tcp":
		if ci.Port == "" {
			ci.Port = "3011"
		}
	default:
		return nil, fmt.Errorf("unsupported scheme: %s", scheme)
	}
	return ci, nil
}

func (c *ConnInfo) IsHTTP() bool {
	return c.Scheme == "http" || c.Scheme == "https"
}

func (c *ConnInfo) Address() string {
	return fmt.Sprintf("%s:%s", c.Host, c.Port)
}
