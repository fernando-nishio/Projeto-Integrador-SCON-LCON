package main

// Autenticação dos usuários do site:
//
//   - Senhas guardadas só como hash PBKDF2-HMAC-SHA256 (600 mil iterações, sal
//     aleatório por usuário) — algoritmo recomendado pelo NIST e pela OWASP,
//     disponível na biblioteca padrão do Go (crypto/pbkdf2).
//   - Após o login, o navegador recebe um JWT (assinado com HMAC-SHA256 e a
//     JWT_SECRET do .env) num cookie HttpOnly: o JavaScript da página não consegue
//     lê-lo (protege contra roubo por XSS) e SameSite=Strict impede que outros
//     sites o usem (protege contra CSRF).

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	pbkdf2Iter  = 600_000
	cookieName  = "pi_sessao"
	sessaoHoras = 8
)

var b64url = base64.RawURLEncoding

// ---------- Senhas ----------

// hashPassword gera "pbkdf2-sha256$iterações$sal$hash" (sal e hash em base64).
func hashPassword(senha string) (string, error) {
	sal := make([]byte, 16)
	rand.Read(sal)
	h, err := pbkdf2.Key(sha256.New, senha, sal, pbkdf2Iter, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", pbkdf2Iter, b64.EncodeToString(sal), b64.EncodeToString(h)), nil
}

// verifyPassword recalcula o hash com o mesmo sal e compara em tempo constante.
func verifyPassword(senha, armazenado string) bool {
	p := strings.Split(armazenado, "$")
	if len(p) != 4 || p[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err1 := strconv.Atoi(p[1])
	sal, err2 := b64.DecodeString(p[2])
	esperado, err3 := b64.DecodeString(p[3])
	if errors.Join(err1, err2, err3) != nil {
		return false
	}
	h, err := pbkdf2.Key(sha256.New, senha, sal, iter, len(esperado))
	return err == nil && subtle.ConstantTimeCompare(h, esperado) == 1
}

// Hash "de mentira" usado quando o usuário não existe: o servidor faz o mesmo
// trabalho de verificar uma senha, então o tempo de resposta não revela se o
// nome de usuário existe ou não.
var dummyHash = sync.OnceValue(func() string {
	h, _ := hashPassword("usuario-inexistente")
	return h
})

// ---------- JWT (HS256) ----------

type Claims struct {
	Sub  int64  `json:"sub"`  // id do usuário
	Name string `json:"name"` // username
	Role string `json:"role"` // "admin" ou "user"
	Iat  int64  `json:"iat"`  // emitido em (segundos desde 1970)
	Exp  int64  `json:"exp"`  // expira em
}

var jwtHeader = b64url.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))

func (a *App) signJWT(c Claims) string {
	payload, _ := json.Marshal(c)
	conteudo := jwtHeader + "." + b64url.EncodeToString(payload)
	mac := hmac.New(sha256.New, a.cfg.JWTSecret)
	mac.Write([]byte(conteudo))
	return conteudo + "." + b64url.EncodeToString(mac.Sum(nil))
}

func (a *App) verifyJWT(token string) (*Claims, error) {
	p := strings.Split(token, ".")
	if len(p) != 3 || p[0] != jwtHeader { // só aceita exatamente o cabeçalho HS256 que nós emitimos
		return nil, errors.New("token mal formado")
	}
	mac := hmac.New(sha256.New, a.cfg.JWTSecret)
	mac.Write([]byte(p[0] + "." + p[1]))
	assinatura, err := b64url.DecodeString(p[2])
	if err != nil || !hmac.Equal(assinatura, mac.Sum(nil)) {
		return nil, errors.New("assinatura inválida")
	}
	payload, err := b64url.DecodeString(p[1])
	if err != nil {
		return nil, err
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, err
	}
	if time.Now().Unix() >= c.Exp {
		return nil, errors.New("sessão expirada")
	}
	return &c, nil
}

// ---------- Cookie de sessão ----------

func setSessionCookie(w http.ResponseWriter, token string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAge, // segundos; -1 apaga o cookie
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		// Secure: true exigiria HTTPS; o sistema roda em http://localhost.
	})
}

// authenticate lê e valida o cookie de sessão da requisição.
func (a *App) authenticate(r *http.Request) (*Claims, error) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil, errors.New("faça login para continuar")
	}
	return a.verifyJWT(c.Value)
}

// requireAuth protege uma rota: exige sessão válida e, se roles for informado,
// um desses papéis. O usuário fica disponível em reqUser(r).
func (a *App) requireAuth(next http.HandlerFunc, roles ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := a.authenticate(r)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, errBody("Sessão inválida ou expirada: faça login novamente"))
			return
		}
		if info := getInfo(r); info != nil {
			info.user = c // o log da requisição passa a registrar quem fez (inclusive tentativas negadas)
		}
		if len(roles) > 0 && !slices.Contains(roles, c.Role) {
			writeJSON(w, http.StatusForbidden, errBody("Acesso restrito a administradores"))
			return
		}
		next(w, r)
	}
}

// reqUser devolve o usuário autenticado da requisição (nil se não houver).
func reqUser(r *http.Request) *Claims {
	if info := getInfo(r); info != nil {
		return info.user
	}
	return nil
}

func userIDPtr(c *Claims) *int64 {
	if c == nil {
		return nil
	}
	id := c.Sub
	return &id
}
