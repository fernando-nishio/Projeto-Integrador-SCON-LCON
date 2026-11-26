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
├── public/ltr701.glb       # modelo 3D do kit (glTF binário, metros, Y para cima)
├── vite.config.js          # em desenvolvimento, repassa /api para o backend (porta 3000)
├── package.json            # dependências: react, react-dom, chart.js (+ vite para compilar)
└── src/
    ├── main.jsx            # ponto de entrada
    ├── App.jsx             # decide entre login e páginas; navegação por #/ e #/admin
    ├── api.js              # todas as chamadas à API + conversão de horário do InfluxDB
    ├── styles.css          # visual (cores com versão clara e escura)
    ├── components/
    │   ├── LiveChart.jsx   # gráfico de linha atualizado em tempo real (Chart.js)
    │   └── Gemeo3D.jsx     # gêmeo digital 3D (three.js): LCD, tubo e LED seguem a planta
    ├── sim/
    │   ├── modelo.js       # planta (1ª ordem + atraso) + PI/filtro iguais ao cliente_planta.m + métricas
    │   ├── identificar.js  # ajuste de K, τ, θ e T_amb por mínimos quadrados; leitura de CSV
    │   └── sim.test.js     # testes (npm test)
    ├── gemeo/
    │   └── lcdLtr701.js    # desenha a tela LCD do modelo num <canvas> usado como textura
    └── pages/
        ├── Login.jsx       # login; no primeiro acesso, cria o administrador
        ├── Dashboard.jsx   # valores atuais, gêmeo 3D, gráficos, comandos, últimas leituras
        ├── Simulacao.jsx   # modelo matemático da planta: simulação e identificação
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

## Aba Simulação (modelo digital)

Modelo matemático do soprador, sem usar o kit:

```
            K · e^(−θs)
   G(s) = ─────────────      T = T_amb + resposta de G ao sinal u (V)
             τs + 1
```

- **Simulação:** discretizada a 100 Hz e com o mesmo laço do `cliente_planta.m`: ruído de leitura, filtro de Tustin, PI com integrador de Euler, saturação 0–U_MAX e os primeiros passos sem controle. Em malha fechada mostra sobressinal, tempo de subida, acomodação (2%), erro em regime e tempo saturado. Em malha aberta aplica degraus de tensão direto no aquecedor.
- **Identificação:** ajusta `y[k+1] = a·y[k] + b·u[k−d] + c` por mínimos quadrados, testa atrasos de 0 a 5 s e converte para K, τ, θ e T_amb. O "ajuste" é medido em simulação livre (o modelo só vê u), no mesmo formato do `compare` do MATLAB. Os dados podem vir dos últimos 200 s do banco, de um CSV (`t, temp, u`) ou da própria simulação, para conferir o método.
- **"O que o kit faria":** o modelo 3D reproduz o ensaio simulado numa linha do tempo (play/pause, barra para arrastar e velocidade de 1× a 20×). O LCD mostra os valores previstos com "SIMULACAO" no cabeçalho, o tubo muda de cor com a temperatura, e uma linha tracejada marca o mesmo instante nos gráficos. O botão "Ver o LCD" aproxima a câmera da tela (também no Painel).
- **Parâmetros:** o padrão é o modelo da Atividade 07 de LCON-I, `G(s) = 1,387/(s + 0,2351)` (K = 5,90 °C/V, τ = 4,25 s), com T_amb = 24,4 °C. O botão "Partida a frio" acrescenta o atraso de 2,2 s medido no ensaio, que o script02 cortou antes do ajuste, para ver o pior caso. "Usar estes parâmetros" (identificação) salva no navegador (localStorage).

Para identificar o kit: com o controle ligado, mude o setpoint algumas vezes (ex.: 35 → 50 → 40 °C, esperando estabilizar entre as mudanças) e clique em "Últimos 200 s da planta". Um ajuste acima de ~90% indica um bom modelo.

Testes: `npm test` (Node 20+, sem dependências).
