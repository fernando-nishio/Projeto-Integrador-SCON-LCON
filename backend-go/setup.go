package main

// "backend setup": prepara a configuração do projeto. Roda sozinho a cada
// "docker compose up" (serviço "setup").
//
//  1. Cria o .env da raiz a partir do .env.example (ou completa o .env existente):
//     onde houver "troque_..." / "cole_aqui..." / vazio, gera um valor aleatório.
//     Valores que você já definiu NUNCA são trocados.
//  2. Dentro do Docker (CONFIG_DIR definido), copia a configuração para o volume
//     "config", de onde os outros containers leem:
//     app.env                  -> .env do backend
//     db_password              -> senha inicial do Postgres
//     influx-admin-token.json  -> token de admin inicial do InfluxDB
//
// Nenhum segredo é impresso na tela.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

var geradores = map[string]func() string{
	"DB_PASSWORD":    func() string { return randomHex(16) },
	"ENCRYPTION_KEY": func() string { return randomHex(32) }, // 32 bytes = AES-256
	"DEVICE_KEY":     func() string { return randomHex(16) },
	"JWT_SECRET":     func() string { return randomHex(48) },
	// O InfluxDB exige o prefixo "apiv3_" e ao menos 16 bytes aleatórios
	"INFLUX_TOKEN": func() string {
		b := make([]byte, 32)
		rand.Read(b)
		return "apiv3_" + base64.RawURLEncoding.EncodeToString(b)
	},
}

var (
	placeholderRe = regexp.MustCompile(`^(|troque_.*|cole_aqui.*)$`)
	envLineRe     = regexp.MustCompile(`^\s*([A-Z0-9_]+)=(.*)$`) // linha do .env
	exampleLineRe = regexp.MustCompile(`^([A-Z0-9_]+)=(.*)$`)    // linha de variável no .env.example
)

// lerEnv lê um arquivo KEY=VALOR guardando também a ordem das chaves.
func lerEnv(path string) (map[string]string, []string) {
	vals := map[string]string{}
	var ordem []string
	data, err := os.ReadFile(path)
	if err != nil {
		return vals, ordem
	}
	for _, line := range strings.Split(string(data), "\n") {
		if m := envLineRe.FindStringSubmatch(line); m != nil {
			if _, seen := vals[m[1]]; !seen {
				ordem = append(ordem, m[1])
			}
			vals[m[1]] = strings.TrimSpace(m[2])
		}
	}
	return vals, ordem
}

func runSetup() int {
	repo := getenv("REPO_DIR", "..") // fora do Docker, roda-se de dentro de backend-go/
	configDir := os.Getenv("CONFIG_DIR")
	envPath := filepath.Join(repo, ".env")
	examplePath := filepath.Join(repo, ".env.example")

	example, err := os.ReadFile(examplePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[setup] não encontrei", examplePath)
		return 1
	}

	// ---------- 1. Monta o .env seguindo a ordem/comentários do .env.example ----------
	atual, ordemAtual := lerEnv(envPath)
	var linhas, gerados []string
	usadas := map[string]bool{}

	for _, line := range strings.Split(string(example), "\n") {
		m := exampleLineRe.FindStringSubmatch(line)
		if m == nil {
			linhas = append(linhas, line) // comentário ou linha vazia
			continue
		}
		chave, valor := m[1], strings.TrimSpace(m[2])
		usadas[chave] = true
		if v, ok := atual[chave]; ok {
			valor = v
		}
		if gerar, ok := geradores[chave]; ok && placeholderRe.MatchString(valor) {
			valor = gerar()
			gerados = append(gerados, chave)
		}
		linhas = append(linhas, chave+"="+valor)
	}

	// Variáveis que você tenha acrescentado ao .env e que não estão no modelo são mantidas
	var extras []string
	for _, k := range ordemAtual {
		if !usadas[k] {
			extras = append(extras, k+"="+atual[k])
		}
	}
	if len(extras) > 0 {
		linhas = append(linhas, "", "# Outras variáveis")
		linhas = append(linhas, extras...)
	}

	conteudo := strings.TrimRight(strings.Join(linhas, "\n"), "\n") + "\n"
	anterior, errAnt := os.ReadFile(envPath)

	if errAnt != nil || string(anterior) != conteudo {
		if err := os.WriteFile(envPath, []byte(conteudo), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, "[setup] não consegui gravar o .env:", err)
			return 1
		}
		os.Chmod(envPath, 0o600) // só o dono lê/escreve
		devolverAoDono(envPath, repo)
		if errAnt != nil {
			fmt.Println("[setup] .env criado")
		} else {
			fmt.Println("[setup] .env atualizado")
		}
		if len(gerados) > 0 {
			fmt.Println("[setup] valores gerados:", strings.Join(gerados, ", "))
		}
	} else {
		fmt.Println("[setup] .env já estava completo")
	}

	// ---------- 2. Arquivos para os containers ----------
	if configDir != "" {
		env, _ := lerEnv(envPath)
		token, _ := json.Marshal(map[string]string{
			"token": env["INFLUX_TOKEN"], "name": "_admin", "description": "Token do backend (gerado pelo setup)",
		})
		// 0644: legíveis pelos usuários internos do Postgres/InfluxDB/backend.
		// O volume fica em /var/lib/docker, acessível só ao root do computador.
		arquivos := map[string][]byte{
			"app.env":                 []byte(conteudo),
			"db_password":             []byte(env["DB_PASSWORD"]),
			"influx-admin-token.json": token,
		}
		os.MkdirAll(configDir, 0o755)
		for nome, dados := range arquivos {
			p := filepath.Join(configDir, nome)
			if err := os.WriteFile(p, dados, 0o644); err != nil {
				fmt.Fprintln(os.Stderr, "[setup] erro ao gravar", p, err)
				return 1
			}
			os.Chmod(p, 0o644)
		}
		fmt.Println("[setup] configuração copiada para o volume dos containers")
	}
	return 0
}
