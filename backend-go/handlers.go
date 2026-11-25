package main

// Rotas da API (as de login, usuários e logs estão em users.go).
//
//	GET  /api/health       -> estado do servidor e dos dois bancos            (aberta)
//	POST /api/data         -> MATLAB envia um lote; resposta traz os comandos (X-Device-Key)
//	GET  /api/commands     -> comandos atuais para o MATLAB                   (X-Device-Key)
//	POST /api/send         -> site envia um comando (setpoint / liga-desliga) (login)
//	GET  /api/status       -> comandos atuais, para o site                    (login)
//	GET  /api/data/latest  -> últimas amostras, decifradas                    (login)
//	GET  /api/stream       -> tempo real (Server-Sent Events)                 (login)

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

	// Dispositivo (MATLAB): autenticado pela chave no header
	mux.HandleFunc("POST /api/data", a.requireDeviceKey(a.handlePostData))
	mux.HandleFunc("GET /api/commands", a.requireDeviceKey(a.handleCommands))

	// Login e usuários
	mux.HandleFunc("GET /api/auth/setup", a.handleSetupStatus)
	mux.HandleFunc("POST /api/auth/login", a.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", a.handleLogout)
	mux.HandleFunc("GET /api/auth/me", a.requireAuth(a.handleMe))
	mux.HandleFunc("POST /api/users", a.handleCreateUser) // confere admin lá dentro (1º usuário é exceção)
	mux.HandleFunc("GET /api/users", a.requireAuth(a.handleListUsers, "admin"))
	mux.HandleFunc("GET /api/logs", a.requireAuth(a.handleLogs, "admin"))

	// Site (qualquer usuário logado: admin ou user)
	mux.HandleFunc("POST /api/send", a.requireAuth(a.handleSend))
	mux.HandleFunc("GET /api/status", a.requireAuth(a.handleStatus))
	mux.HandleFunc("GET /api/data/latest", a.requireAuth(a.handleLatest))
	mux.HandleFunc("GET /api/stream", a.requireAuth(a.handleStream))

	// Todo o resto: arquivos do frontend (ou 404 em JSON para /api/...)
	mux.Handle("/", a.staticHandler())

	return securityHeaders(a.requestLogger(mux)) // log e cabeçalhos embrulham todas as rotas
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

// broadcast manda uma mensagem para todos os dashboards abertos (se houver).
func (a *App) broadcast(v any) {
	if a.hub.Count() == 0 {
		return
	}
	if msg, err := json.Marshal(v); err == nil {
		a.hub.Broadcast(msg)
	}
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

// ---------- POST /api/data (MATLAB) ----------

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

	state, err := a.getCommandState(ctx, true)
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

	// Tempo real: as mesmas amostras (já gravadas cifradas) vão para os dashboards abertos
	a.broadcast(map[string]any{"type": "samples", "device": lote.DeviceID, "samples": lote.Samples, "commands": state})
}

// ---------- GET /api/commands (MATLAB) ----------

func (a *App) handleCommands(w http.ResponseWriter, r *http.Request) {
	state, err := a.getCommandState(r.Context(), true)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao ler comandos"))
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// ---------- POST /api/send (site) ----------

// Corpo: { "name": "setpoint", "value": 40 }  ou  { "name": "enabled", "value": 1 }
func (a *App) handleSend(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := reqUser(r)
	var body struct {
		Name  string   `json:"name"`
		Value *float64 `json:"value"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || body.Value == nil {
		writeJSON(w, http.StatusBadRequest, errBody(`Formato esperado: { "name": "setpoint", "value": 40 }`))
		return
	}
	if msg := validarComando(body.Name, *body.Value); msg != "" {
		writeJSON(w, http.StatusBadRequest, errBody(msg))
		return
	}

	id, err := a.addCommand(ctx, body.Name, *body.Value, userIDPtr(user))
	if err != nil {
		fmt.Println("[send] erro ao gravar o comando:", err)
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao gravar o comando"))
		return
	}
	a.logEvent(ctx, logEntry{EventType: "command_sent",
		Description: fmt.Sprintf("%s=%s por %s", body.Name, formatNum(*body.Value), user.Name),
		IP:          clientIP(r), Status: 201, UserID: userIDPtr(user)})

	state, err := a.getCommandState(ctx, false)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Comando gravado, mas houve erro ao ler o estado"))
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"status": "ok", "id": id, "commands": state})
	a.broadcast(map[string]any{"type": "commands", "commands": state, "by": user.Name})
}

// ---------- GET /api/status (site) ----------

func (a *App) handleStatus(w http.ResponseWriter, r *http.Request) {
	state, err := a.getCommandState(r.Context(), false) // só lê: não marca como entregue
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao ler comandos"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"commands": state, "dashboards": a.hub.Count()})
}

// ---------- GET /api/data/latest (site) ----------

var notFoundRe = regexp.MustCompile(`(?i)not found|does not exist`)

func (a *App) handleLatest(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 {
		limit = 20
	}
	limit = min(limit, 2000) // inteiro de 1 a 2000: seguro para colocar no SQL

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
