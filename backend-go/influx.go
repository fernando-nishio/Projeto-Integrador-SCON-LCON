package main

// Comunicação com o InfluxDB 3 Core pela API HTTP dele (só biblioteca padrão):
//
//	escrita:  POST /api/v3/write_lp   (corpo em "line protocol", uma linha por ponto)
//	leitura:  GET  /api/v3/query_sql  (consulta SQL, resposta em JSON)

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type Influx struct {
	base, db, token string
	client          *http.Client
}

// InfluxError carrega o status HTTP para quem chamou decidir o que fazer.
type InfluxError struct {
	Status int
	Body   string
}

func (e *InfluxError) Error() string {
	return fmt.Sprintf("InfluxDB respondeu %d: %s", e.Status, e.Body)
}

func (i *Influx) do(ctx context.Context, method, path string, query url.Values, body io.Reader) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, i.base+path+"?"+query.Encode(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+i.token)
	if body != nil {
		req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	}

	res, err := i.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 10<<20)) // no máximo 10 MB
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		return nil, &InfluxError{Status: res.StatusCode, Body: strings.TrimSpace(string(data))}
	}
	return data, nil
}

// WriteLines grava várias linhas de line protocol numa única requisição.
// precision=nanosecond: o timestamp no fim de cada linha está em nanossegundos.
func (i *Influx) WriteLines(ctx context.Context, lines []string) error {
	q := url.Values{"db": {i.db}, "precision": {"nanosecond"}}
	_, err := i.do(ctx, http.MethodPost, "/api/v3/write_lp", q, strings.NewReader(strings.Join(lines, "\n")))
	return err
}

// QuerySQL executa uma consulta e devolve uma lista de linhas (cada linha = mapa coluna -> valor).
func (i *Influx) QuerySQL(ctx context.Context, sql string) ([]map[string]any, error) {
	q := url.Values{"db": {i.db}, "q": {sql}, "format": {"json"}}
	data, err := i.do(ctx, http.MethodGet, "/api/v3/query_sql", q, nil)
	if err != nil {
		return nil, err
	}
	var rows []map[string]any
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, fmt.Errorf("resposta do InfluxDB em formato inesperado: %w", err)
	}
	return rows, nil
}

// Healthy é usado pelo /api/health.
func (i *Influx) Healthy(ctx context.Context) bool {
	_, err := i.do(ctx, http.MethodGet, "/health", url.Values{}, nil)
	return err == nil
}
