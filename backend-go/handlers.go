package main

// Rotas da API.
//
//	GET  /api/health       -> estado do servidor e dos dois bancos
//	POST /api/data         -> MATLAB envia um lote de amostras (exige X-Device-Key);
//	                          a resposta já traz os comandos atuais
//	GET  /api/commands     -> comandos atuais { enabled, setpoint } (exige X-Device-Key)
//	GET  /api/data/latest  -> últimas amostras descriptografadas
//	                          (TESTE: será protegida por login no passo 4)

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	// Desde o Go 1.22 o próprio roteador da biblioteca padrão entende "MÉTODO /caminho"
	mux.HandleFunc("GET /api/health", a.handleHealth)
	mux.HandleFunc("POST /api/data", a.requireDeviceKey(a.handlePostData))
	mux.HandleFunc("GET /api/data/latest", a.handleLatest)
	mux.HandleFunc("GET /api/commands", a.requireDeviceKey(a.handleCommands))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { // qualquer outra rota
		writeJSON(w, http.StatusNotFound, errBody("Rota não encontrada"))
	})
	return a.requestLogger(mux) // o log embrulha todas as rotas
}

// ---------- utilitários de resposta ----------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func errBody(msg string) map[string]string {
	return map[string]string{"status": "error", "message": msg}
}

// Mesmo formato do toISOString() do JavaScript: 2026-11-21T17:13:45.067Z
func isoNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// ---------- GET /api/health ----------

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	postgres, influxdb := "ok", "ok"
	if a.db.Ping(ctx) != nil {
		postgres = "indisponível"
	}
	if !a.influx.Healthy(ctx) {
		influxdb = "indisponível"
	}
	status, code := "ok", http.StatusOK
	if postgres != "ok" || influxdb != "ok" {
		status, code = "error", http.StatusServiceUnavailable
	}
	writeJSON(w, code, map[string]string{"status": status, "postgres": postgres, "influxdb": influxdb, "time": isoNow()})
}

// ---------- POST /api/data ----------

func (a *App) handlePostData(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ip := clientIP(r)

	// Limita o corpo a 200 KB (um lote de 1 s a 100 Hz cabe com folga)
	r.Body = http.MaxBytesReader(w, r.Body, 200<<10)
	var lote Lote
	if err := json.NewDecoder(r.Body).Decode(&lote); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("JSON inválido: "+err.Error()))
		return
	}
	if msg := validarLote(&lote); msg != "" {
		a.logEvent(ctx, logEntry{EventType: "data_invalid", Description: msg, IP: ip, Status: 400})
		writeJSON(w, http.StatusBadRequest, errBody(msg))
		return
	}

	// Todas as amostras do lote numa única escrita
	lines := make([]string, len(lote.Samples))
	for i, s := range lote.Samples {
		lines[i] = amostraParaLinha(a.crypt, lote.DeviceID, s)
	}
	if err := a.influx.WriteLines(ctx, lines); err != nil {
		fmt.Println("[data] erro ao gravar no InfluxDB:", err)
		a.logEvent(ctx, logEntry{EventType: "influx_error", Description: err.Error(), IP: ip, Status: 503})
		writeJSON(w, http.StatusServiceUnavailable, errBody("Banco de séries temporais indisponível"))
		return
	}

	a.logEvent(ctx, logEntry{EventType: "data_received",
		Description: fmt.Sprintf("%s: %d amostras", lote.DeviceID, len(lote.Samples)), IP: ip, Status: 201})

	state, err := a.getCommandState(ctx)
	if err != nil {
		fmt.Println("[data] erro ao ler comandos:", err)
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao ler comandos"))
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"status":      "ok",
		"received":    len(lote.Samples),
		"server_time": isoNow(),
		"commands":    state, // { enabled, setpoint }
	})
}

// ---------- GET /api/commands ----------

func (a *App) handleCommands(w http.ResponseWriter, r *http.Request) {
	state, err := a.getCommandState(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao ler comandos"))
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// ---------- GET /api/data/latest ----------

var notFoundRe = regexp.MustCompile(`(?i)not found|does not exist`)

// TODO (passo 4): proteger com login — dados só podem ser descriptografados para usuários autenticados
func (a *App) handleLatest(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 {
		limit = 20
	}
	limit = min(limit, 500) // inteiro de 1 a 500: seguro para colocar no SQL

	rows, err := a.influx.QuerySQL(r.Context(),
		fmt.Sprintf("SELECT * FROM %s ORDER BY time DESC LIMIT %d", measurement, limit))
	if err != nil {
		// Antes da primeira escrita o banco/tabela ainda não existem: devolve lista vazia
		var ie *InfluxError
		if errors.As(err, &ie) && notFoundRe.MatchString(ie.Body) {
			writeJSON(w, http.StatusOK, []any{})
			return
		}
		fmt.Println("[latest] erro:", err)
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao consultar o InfluxDB"))
		return
	}

	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		item := map[string]any{"time": row["time"], "device": row["device"]}
		for k, v := range row {
			enc, isStr := v.(string)
			if k == "time" || k == "device" || !isStr {
				continue
			}
			plain, err := a.crypt.Decrypt(enc)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, errBody("Falha ao descriptografar"))
				return
			}
			item[k], _ = strconv.ParseFloat(plain, 64)
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}
