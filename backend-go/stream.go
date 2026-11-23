package main

// Tempo real para o dashboard com Server-Sent Events (SSE).
//
// O navegador abre GET /api/stream e a conexão fica aberta: a cada lote que chega
// do MATLAB (e a cada comando enviado pelo site) o backend empurra uma mensagem
// "data: {...}". O dashboard só precisa RECEBER em tempo real — os comandos vão
// por POST /api/send —, então SSE basta: é HTTP comum, o navegador reconecta
// sozinho (EventSource) e o Go faz isso só com a biblioteca padrão. WebSocket
// seria necessário se o navegador também tivesse que enviar pela mesma conexão.

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Hub distribui cada mensagem para todos os dashboards conectados.
type Hub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

func newHub() *Hub { return &Hub{subs: map[chan []byte]struct{}{}} }

func (h *Hub) subscribe() chan []byte {
	ch := make(chan []byte, 16) // pequena fila por cliente
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *Hub) unsubscribe(ch chan []byte) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

// Broadcast nunca bloqueia: se um navegador estiver lento e com a fila cheia, ele
// perde essa mensagem (o próximo lote chega em 1 s) em vez de travar o backend.
func (h *Hub) Broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- msg:
		default:
		}
	}
}

func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

// GET /api/stream (usuário logado)
func (a *App) handleStream(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no") // evita que proxies segurem as mensagens

	ch := a.hub.subscribe()
	defer a.hub.unsubscribe(ch)

	fmt.Fprint(w, "retry: 2000\n: conectado\n\n") // se cair, o navegador tenta de novo em 2 s
	if rc.Flush() != nil {
		return
	}

	ping := time.NewTicker(15 * time.Second) // mantém a conexão viva mesmo sem dados
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done(): // navegador fechou a aba / saiu da página
			return
		case msg := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
		}
		if rc.Flush() != nil {
			return
		}
	}
}
