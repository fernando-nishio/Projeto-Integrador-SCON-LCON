package main

// Rotas de login, usuários e logs.
//
//	GET  /api/auth/setup   -> { needs_admin } — true enquanto não existir nenhum usuário
//	POST /api/auth/login   -> confere senha, grava o cookie de sessão
//	POST /api/auth/logout  -> apaga o cookie
//	GET  /api/auth/me      -> usuário da sessão atual
//	GET  /api/users        -> lista usuários (admin)
//	POST /api/users        -> cria usuário (admin; o PRIMEIRO usuário do sistema
//	                          pode ser criado sem login e vira admin)
//	GET  /api/logs         -> últimos logs, decifrados (admin)

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{3,50}$`)

type userJSON struct {
	ID        int64     `json:"id"`
	Username  string    `json:"username"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at,omitzero"`
}

func (a *App) countUsers(ctx context.Context) (int64, error) {
	var n int64
	err := a.db.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

// ---------- GET /api/auth/setup ----------

func (a *App) handleSetupStatus(w http.ResponseWriter, r *http.Request) {
	n, err := a.countUsers(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao consultar usuários"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"needs_admin": n == 0})
}

// ---------- POST /api/auth/login ----------

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct{ Username, Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("JSON inválido"))
		return
	}

	var u userJSON
	var hash string
	err := a.db.QueryRow(ctx, `SELECT id, username, role, password_hash FROM users WHERE username = $1`,
		body.Username).Scan(&u.ID, &u.Username, &u.Role, &hash)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao consultar usuários"))
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		hash = dummyHash() // mesmo custo de verificação, exista ou não o usuário
	}

	if !verifyPassword(body.Password, hash) || err != nil {
		a.logEvent(ctx, logEntry{EventType: "login_failed", Description: "usuário: " + body.Username, IP: clientIP(r), Status: 401})
		time.Sleep(500 * time.Millisecond) // atrasa tentativas de adivinhar senha em sequência
		writeJSON(w, http.StatusUnauthorized, errBody("Usuário ou senha incorretos"))
		return
	}

	agora := time.Now()
	token := a.signJWT(Claims{Sub: u.ID, Name: u.Username, Role: u.Role,
		Iat: agora.Unix(), Exp: agora.Add(sessaoHoras * time.Hour).Unix()})
	setSessionCookie(w, token, sessaoHoras*3600)

	a.logEvent(ctx, logEntry{EventType: "login_ok", Description: "usuário: " + u.Username, IP: clientIP(r), Status: 200, UserID: &u.ID})
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}

// ---------- POST /api/auth/logout ----------

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := a.authenticate(r); err == nil {
		a.logEvent(r.Context(), logEntry{EventType: "logout", Description: "usuário: " + c.Name, IP: clientIP(r), Status: 200, UserID: userIDPtr(c)})
	}
	setSessionCookie(w, "", -1)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ---------- GET /api/auth/me ----------

func (a *App) handleMe(w http.ResponseWriter, r *http.Request) {
	c := reqUser(r)
	writeJSON(w, http.StatusOK, map[string]any{"user": userJSON{ID: c.Sub, Username: c.Name, Role: c.Role}})
}

// ---------- GET /api/users (admin) ----------

func (a *App) handleListUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `SELECT id, username, role, created_at FROM users ORDER BY id`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao listar usuários"))
		return
	}
	defer rows.Close()
	lista := []userJSON{}
	for rows.Next() {
		var u userJSON
		if err := rows.Scan(&u.ID, &u.Username, &u.Role, &u.CreatedAt); err != nil {
			writeJSON(w, http.StatusInternalServerError, errBody("Erro ao listar usuários"))
			return
		}
		lista = append(lista, u)
	}
	writeJSON(w, http.StatusOK, lista)
}

// ---------- POST /api/users ----------

func (a *App) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct{ Username, Password, Role string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody("JSON inválido"))
		return
	}

	n, err := a.countUsers(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao consultar usuários"))
		return
	}
	var criador *Claims
	if n == 0 {
		body.Role = "admin" // primeiro usuário do sistema: vira administrador, sem precisar de login
	} else {
		c, err := a.authenticate(r)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, errBody("Faça login como administrador para cadastrar usuários"))
			return
		}
		if c.Role != "admin" {
			writeJSON(w, http.StatusForbidden, errBody("Só administradores podem cadastrar usuários"))
			return
		}
		criador = c
		if info := getInfo(r); info != nil {
			info.user = c
		}
	}

	switch {
	case !usernameRe.MatchString(body.Username):
		writeJSON(w, http.StatusBadRequest, errBody("Usuário: 3 a 50 caracteres (letras, números, _ . -)"))
		return
	case len(body.Password) < 8 || len(body.Password) > 200:
		writeJSON(w, http.StatusBadRequest, errBody("A senha precisa ter pelo menos 8 caracteres"))
		return
	case body.Role != "admin" && body.Role != "user":
		writeJSON(w, http.StatusBadRequest, errBody(`Papel deve ser "admin" ou "user"`))
		return
	}

	var existe bool
	if err := a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)`, body.Username).Scan(&existe); err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao consultar usuários"))
		return
	}
	if existe {
		writeJSON(w, http.StatusConflict, errBody("Já existe um usuário com esse nome"))
		return
	}

	hash, err := hashPassword(body.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao gerar hash da senha"))
		return
	}
	u := userJSON{Username: body.Username, Role: body.Role}
	err = a.db.QueryRow(ctx,
		`INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, created_at`,
		u.Username, hash, u.Role).Scan(&u.ID, &u.CreatedAt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao criar usuário"))
		return
	}

	desc := fmt.Sprintf("criado %s (%s)", u.Username, u.Role)
	if criador == nil {
		desc += " — primeiro administrador do sistema"
	}
	a.logEvent(ctx, logEntry{EventType: "user_created", Description: desc, IP: clientIP(r), Status: 201, UserID: userIDPtr(criador)})
	writeJSON(w, http.StatusCreated, u)
}

// ---------- GET /api/logs (admin) ----------

type logJSON struct {
	ID          int64     `json:"id"`
	Timestamp   time.Time `json:"timestamp"`
	EventType   string    `json:"event_type"`
	Description string    `json:"description"`
	IP          string    `json:"ip"`
	Status      *int64    `json:"status"`
	Username    *string   `json:"username"`
}

func (a *App) handleLogs(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 {
		limit = 100
	}
	limit = min(limit, 1000)

	rows, err := a.db.Query(r.Context(),
		`SELECT l.id, l.timestamp, l.event_type, l.description, l.ip, l.status, u.username
		   FROM logs l LEFT JOIN users u ON u.id = l.user_id
		  ORDER BY l.id DESC LIMIT $1`, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("Erro ao ler logs"))
		return
	}
	defer rows.Close()

	// Descriptografa um campo que pode ser NULL
	abrir := func(enc *string) string {
		if enc == nil {
			return ""
		}
		v, err := a.crypt.Decrypt(*enc)
		if err != nil {
			return "(não foi possível decifrar)"
		}
		return v
	}

	lista := []logJSON{}
	for rows.Next() {
		var l logJSON
		var desc, ip *string
		if err := rows.Scan(&l.ID, &l.Timestamp, &l.EventType, &desc, &ip, &l.Status, &l.Username); err != nil {
			writeJSON(w, http.StatusInternalServerError, errBody("Erro ao ler logs"))
			return
		}
		l.Description, l.IP = abrir(desc), abrir(ip)
		lista = append(lista, l)
	}
	writeJSON(w, http.StatusOK, lista)
}
