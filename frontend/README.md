# Frontend — React + Vite

O site do sistema: login, painel em tempo real e administração.

Em produção, o Docker compila este projeto (`npm run build`), e o resultado vai **para dentro do binário do backend Go** (`//go:embed`). Site e API ficam no mesmo endereço, **http://localhost:3000**, então o cookie de login funciona sem configuração extra.

| Tecnologia | Para quê | Por que esta |
|---|---|---|
| **React 19** | Interface em componentes | Sugerido no PDF; cada parte da tela (gráfico, formulário, tabela) é um componente reutilizável |
| **Vite** | Build e servidor de desenvolvimento | Compila em segundos e gera arquivos com hash no nome (cache longo no navegador) |
| **Chart.js** | Gráficos | Sugerido no PDF; desenha em `<canvas>`, leve para ~1200 pontos atualizados a cada segundo |
| **EventSource (SSE)** | Tempo real | API nativa do navegador, reconecta sozinha; o painel só precisa *receber* dados |
| **fetch** | Chamadas à API | Nativo do navegador, sem dependência extra (o PDF cita Axios, que faz o mesmo) |
| CSS puro com variáveis | Visual, modo claro/escuro | Sem framework de CSS; cores por papel, trocadas num lugar só |

## Arquivos

```
frontend/
├── index.html              # página base; o React monta tudo dentro de <div id="root">
├── vite.config.js          # em desenvolvimento, repassa /api para o backend (porta 3000)
├── package.json            # dependências: react, react-dom, chart.js (+ vite para compilar)
└── src/
    ├── main.jsx            # ponto de entrada
    ├── App.jsx             # decide entre login e páginas; navegação por #/ e #/admin
    ├── api.js              # todas as chamadas à API + conversão de horário do InfluxDB
    ├── styles.css          # visual (cores com versão clara e escura)
    ├── components/
    │   └── LiveChart.jsx   # gráfico de linha atualizado em tempo real (Chart.js)
    └── pages/
        ├── Login.jsx       # login; no primeiro acesso, cria o administrador
        ├── Dashboard.jsx   # valores atuais, gráficos, comandos, últimas leituras
        └── Admin.jsx       # usuários (cadastro) e logs (só admin)
```

## Como os dados chegam ao painel

1. **Ao abrir:** `GET /api/data/latest?limit=1200` traz os últimos 120 s (10 amostras por segundo), e `GET /api/status` traz o setpoint e o liga/desliga atuais.
2. **Tempo real:** `new EventSource('/api/stream')`. A cada lote do MATLAB (1 por segundo), o backend empurra as amostras, que entram no fim da lista. As mais antigas que 120 s saem.
3. **Comandos:** `POST /api/send` com `{ name: "setpoint", value: 40 }` ou `{ name: "enabled", value: 1 }`. Todos os painéis abertos recebem o novo estado na hora, e o MATLAB recebe na próxima troca (até 1 s).

## Gráficos

- **Temperatura e setpoint** num gráfico, e **sinal de controle** em outro. As grandezas têm unidades diferentes (°C e V), e por isso não dividem o mesmo gráfico com dois eixos Y.
- Cores da paleta categórica validada para daltonismo: azul para a temperatura e laranja para o setpoint. Cada modo, claro e escuro, tem os próprios tons.
- Passar o mouse mostra os valores daquele instante.

## Rodar em desenvolvimento

Precisa de Node.js 20+. Com o backend rodando no Docker:
```bash
npm install
npm run dev     # http://localhost:5173
```
