package main

// "Middlewares" são funções que embrulham uma rota: rodam antes/depois dela e
// podem barrar a requisição.

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"time"
)

// statusRecorder guarda o status HTTP que a rota respondeu (o http.ResponseWriter
// padrão não deixa ler isso depois).
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// clientIP tira a porta do endereço remoto ("127.0.0.1:54321" -> "127.0.0.1").
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// requestLogger registra TODA requisição na tabela logs (timestamp, IP, método,
// rota, duração, status) — requisito "cada requisição deve ser registrada em log".
func (a *App) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(rec, r) // executa a rota de fato

		ms := float64(time.Since(start).Microseconds()) / 1000
		desc := fmt.Sprintf("%s %s (%.1f ms)", r.Method, r.URL.RequestURI(), ms)
		ip := clientIP(r)
		fmt.Printf("[%d] %s de %s\n", rec.status, desc, ip)

		eventType := "http_request"
		if rec.status >= 400 {
			eventType = "http_error"
		}
		// "go" roda em paralelo (goroutine): gravar o log não atrasa a resposta
		go a.logEvent(context.Background(), logEntry{EventType: eventType, Description: desc, IP: ip, Status: rec.status})
	})
}

// requireDeviceKey valida a origem das requisições do MATLAB: header X-Device-Key.
// ConstantTimeCompare compara em tempo constante, evitando ataques que medem o
// tempo da comparação para adivinhar a chave aos poucos.
func (a *App) requireDeviceKey(next http.HandlerFunc) http.HandlerFunc {
	expected := []byte(a.cfg.DeviceKey)
	return func(w http.ResponseWriter, r *http.Request) {
		received := []byte(r.Header.Get("X-Device-Key"))
		if len(expected) == 0 || subtle.ConstantTimeCompare(received, expected) != 1 {
			writeJSON(w, http.StatusUnauthorized, errBody("Chave do dispositivo ausente ou inválida"))
			return
		}
		next(w, r)
	}
}
