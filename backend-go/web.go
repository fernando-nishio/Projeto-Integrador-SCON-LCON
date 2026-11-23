package main

// Serve o frontend (React compilado) a partir do próprio binário.
//
// No Docker, o build do React (frontend/dist) é copiado para backend-go/web antes
// de compilar o Go, e o //go:embed guarda esses arquivos DENTRO do binário. Assim a
// imagem final continua sendo um único arquivo, e site e API ficam no mesmo
// endereço (http://localhost:3000) — o cookie de sessão funciona sem configuração
// extra de CORS.

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:web
var webFiles embed.FS

func (a *App) staticHandler() http.Handler {
	site, _ := fs.Sub(webFiles, "web")
	files := http.FileServerFS(site)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") { // rota de API inexistente
			writeJSON(w, http.StatusNotFound, errBody("Rota não encontrada"))
			return
		}
		nome := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if nome == "" {
			nome = "index.html"
		}
		if _, err := fs.Stat(site, nome); err != nil {
			// Caminho que não é arquivo (ex.: /admin): o React decide a página
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			w.Header().Set("Cache-Control", "no-cache")
			files.ServeHTTP(w, r2)
			return
		}
		if strings.HasPrefix(nome, "assets/") {
			// Arquivos com hash no nome (gerados pelo Vite) nunca mudam: cache longo
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
