package main

// Testes automáticos. Rodar sem ter Go instalado (na raiz do repositório):
//
//	docker run --rm -u "$(id -u):$(id -g)" -e GOCACHE=/tmp/gocache -e GOMODCACHE=/tmp/gomod \
//	  -v "$PWD/backend-go":/src -w /src golang:1.25-alpine sh -c "go mod tidy && go test -v ./..."
//
// Com Go instalado: cd backend-go && go test -v ./...

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var chaveTeste = []byte("0123456789abcdef0123456789abcdef") // 32 bytes

func TestCriptografiaIdaEVolta(t *testing.T) {
	c, _ := NewCipher(chaveTeste)
	a, b := c.Encrypt("31.42"), c.Encrypt("31.42")
	if a == b {
		t.Fatal("o mesmo valor cifrado duas vezes deveria dar textos diferentes (IV aleatório)")
	}
	if got, err := c.Decrypt(a); err != nil || got != "31.42" {
		t.Fatalf("Decrypt = %q, %v", got, err)
	}
	if len(strings.Split(a, ":")) != 3 {
		t.Fatalf("formato deveria ser iv:tag:cifrado, veio %q", a)
	}
}

func TestCriptografiaDetectaAdulteracao(t *testing.T) {
	c, _ := NewCipher(chaveTeste)
	p := strings.Split(c.Encrypt("40"), ":")
	p[2] = "QUFB" // troca o texto cifrado
	if _, err := c.Decrypt(strings.Join(p, ":")); err == nil {
		t.Fatal("dado adulterado deveria falhar na descriptografia")
	}
	outra, _ := NewCipher([]byte("ffffffffffffffffffffffffffffffff"))
	if _, err := outra.Decrypt(c.Encrypt("40")); err == nil {
		t.Fatal("chave errada deveria falhar")
	}
}

func TestValidarLote(t *testing.T) {
	ok := &Lote{DeviceID: "LTR701_SIM", Samples: []map[string]any{{"t": 1763740000123.4, "temp": 31.42}}}
	if msg := validarLote(ok); msg != "" {
		t.Fatalf("lote válido recusado: %s", msg)
	}
	casos := map[string]*Lote{
		"sem t":             {DeviceID: "x", Samples: []map[string]any{{"temp": 1.0}}},
		"device com espaço": {DeviceID: "a b", Samples: []map[string]any{{"t": 1.0, "temp": 1.0}}},
		"valor texto":       {DeviceID: "x", Samples: []map[string]any{{"t": 1.0, "temp": "31"}}},
		"campo reservado":   {DeviceID: "x", Samples: []map[string]any{{"t": 1.0, "time": 3.0}}},
		"lista vazia":       {DeviceID: "x", Samples: nil},
		"injeção no nome":   {DeviceID: "x", Samples: []map[string]any{{"t": 1.0, "a=1 b": 2.0}}},
		"só t":              {DeviceID: "x", Samples: []map[string]any{{"t": 1.0}}},
	}
	for nome, l := range casos {
		if validarLote(l) == "" {
			t.Errorf("%s: deveria ser recusado", nome)
		}
	}
}

func TestAmostraParaLinha(t *testing.T) {
	c, _ := NewCipher(chaveTeste)
	linha := amostraParaLinha(c, "LTR701_SIM", map[string]any{"t": 1763740000123.4, "u": 4.1, "temp": 31.42})
	partes := strings.Split(linha, " ")
	if len(partes) != 3 || partes[0] != "planta,device=LTR701_SIM" {
		t.Fatalf("linha mal formada: %s", linha)
	}
	if partes[2] != "1763740000123400000" {
		t.Fatalf("timestamp em ns errado: %s", partes[2])
	}
	if !strings.HasPrefix(partes[1], `temp="`) || !strings.Contains(partes[1], `,u="`) {
		t.Fatalf("campos fora de ordem ou sem aspas: %s", partes[1])
	}
	enc := strings.TrimSuffix(strings.TrimPrefix(strings.Split(partes[1], ",")[0], `temp="`), `"`)
	if v, _ := c.Decrypt(enc); v != "31.42" {
		t.Fatalf("valor decifrado = %q", v)
	}
}

func TestValidarComando(t *testing.T) {
	if validarComando("setpoint", 40) != "" || validarComando("enabled", 1) != "" {
		t.Fatal("comandos válidos recusados")
	}
	for _, c := range []struct {
		n string
		v float64
	}{{"setpoint", 0}, {"setpoint", 100}, {"enabled", 2}, {"kp", 1}} {
		if validarComando(c.n, c.v) == "" {
			t.Errorf("%s=%v deveria ser recusado", c.n, c.v)
		}
	}
}

func TestSetupPreservaValoresDoUsuario(t *testing.T) {
	repo, cfg := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(repo, ".env.example"),
		[]byte("# comentário\nDB_PORT=5433\nDB_PASSWORD=troque_esta_senha\nENCRYPTION_KEY=troque_x\nINFLUX_TOKEN=cole_aqui\n"), 0o644)
	os.WriteFile(filepath.Join(repo, ".env"), []byte("DB_PASSWORD=minhaSenha\nMINHA_VAR=abc\n"), 0o600)
	t.Setenv("REPO_DIR", repo)
	t.Setenv("CONFIG_DIR", cfg)

	if runSetup() != 0 {
		t.Fatal("setup falhou")
	}
	env, _ := lerEnv(filepath.Join(repo, ".env"))
	if env["DB_PASSWORD"] != "minhaSenha" {
		t.Error("senha definida pelo usuário foi trocada")
	}
	if len(env["ENCRYPTION_KEY"]) != 64 || !strings.HasPrefix(env["INFLUX_TOKEN"], "apiv3_") {
		t.Error("chave/token não foram gerados corretamente")
	}
	if env["MINHA_VAR"] != "abc" {
		t.Error("variável extra do usuário foi perdida")
	}
	if pw, _ := os.ReadFile(filepath.Join(cfg, "db_password")); string(pw) != "minhaSenha" {
		t.Error("db_password do volume não confere")
	}
	antes, _ := os.ReadFile(filepath.Join(repo, ".env"))
	runSetup()
	depois, _ := os.ReadFile(filepath.Join(repo, ".env"))
	if string(antes) != string(depois) {
		t.Error("rodar o setup de novo não deveria mudar nada")
	}
}
