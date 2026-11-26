function cliente_planta()
% CLIENTE_PLANTA  Controle PI de temperatura do kit LTR701 + troca de dados com o sistema web.
%
% Baseado no script de LCON-I do grupo (script09): mesma placa (NI-USB-6003),
% mesmos canais, conversão Volts -> °C, filtro, ganhos e saturação. O que muda:
%   - roda até você apertar Ctrl+C (em vez de 30 s fixos);
%   - o setpoint e o liga/desliga vêm do site, na resposta do POST /api/data (1x por segundo);
%   - a placa é encontrada automaticamente (hoje é "Dev4", mas o nome pode mudar).
%
% Por que enviar em lote? Uma requisição HTTP leva ~50 ms. Se fosse feita a cada
% amostra, o laço de 100 Hz não conseguiria acompanhar. Com uma requisição por
% segundo, só alguns passos por segundo atrasam — e isso é medido e mostrado no fim.
%
% Ao parar (Ctrl+C), aquecedor e ventilador são desligados e um resumo é exibido.
%
% Antes de rodar com o kit: seletores dos atuadores 1 e 2 em OFF, ligações com a
% placa conferidas, e o backend no ar (docker compose up -d).

%% ---------------- Configuração ----------------
SIMULACAO = false;   % true = testa sem o kit (um modelo da planta substitui a placa)
DEV_ID    = "";      % "" = encontra a NI-USB-6003 sozinho; ou force o nome, ex.: "Dev4"

% 127.0.0.1 e não "localhost": no Windows, "localhost" tenta primeiro o IPv6 (::1), que o
% Docker não atende, e cada requisição perdia ~2 s (estourando o timeout de 0,5 s).
SERVER     = "http://127.0.0.1:3000/api";
DEVICE_ID  = "LTR701_MATLAB";
DEVICE_KEY = ler_device_key();

Ts            = 0.01;   % período de amostragem: 100 Hz (d.Rate do script de LCON-I)
DECIMACAO     = 10;     % envia 1 a cada 10 amostras (10 Hz no banco)
PERIODO_ENVIO = 1.0;    % um lote por segundo

% ---- Valores do grupo, vindos do script de LCON-I ----
Kp = 1.1;  Ki = 0.4;    % ganhos do PI (NÃO vêm do site, como pede o PDF)
U_MAX   = 9.5;          % saturação do aquecedor (V)
V_VENT  = 2.5;          % tensão fixa do ventilador (ACTUATOR 1)
N_AQUEC = 6;            % primeiras amostras sem controle, enquanto o filtro estabiliza
tau     = 0.012732395447352;   % filtro passa-baixa de 1ª ordem (fc = 1/(2*pi*tau) = 12,5 Hz)
a0 = 1.0 + (2.0*tau/Ts);       % coeficientes do filtro discretizado (Tustin), iguais aos de LCON-I
a1 = 1.0 - (2.0*tau/Ts);

opts = weboptions( ...
    'MediaType',    'application/json', ...
    'ContentType',  'json', ...                     % resposta vira struct
    'HeaderFields', {'X-Device-Key', char(DEVICE_KEY)}, ...
    'Timeout',      0.5);                           % não trava o laço se o servidor cair

%% ---------------- Placa NI-USB-6003 ou simulação ----------------
if SIMULACAO
    % Modelo da Atividade 07 de LCON-I: G(s) = 1.387/(s + 0.2351), sem atraso
    % (o script02 corta os 2,2 s de partida a frio). T_amb = 24,4 °C (Parte A).
    planta.T = 24.4; planta.T_amb = 24.4; planta.a = 0.2351; planta.b = 1.387;
    dq = [];
else
    DEV_ID = encontrar_placa(DEV_ID);
    dq = daq("ni");
    ch = addinput(dq, DEV_ID, "ai0", "Voltage");  % SENSOR 2
    ch.TerminalConfig = "SingleEnded";
    addoutput(dq, DEV_ID, "ao0", "Voltage");       % ACTUATOR 2: aquecedor
    addoutput(dq, DEV_ID, "ao1", "Voltage");       % ACTUATOR 1: ventilador
    dq.Rate = 1/Ts;
    write(dq, [0 V_VENT]);                         % ventilador ligado, aquecedor desligado
end

%% ---------------- Estado ----------------
enabled  = 0;           % começa DESLIGADO até o site mandar enabled = 1
setpoint = 25;
integral = 0;
xf0 = 0; xf1 = 0; yf0 = 0; yf1 = 0;   % memórias do filtro (como em LCON-I)
u = 0;

N_BUF = ceil(PERIODO_ENVIO / Ts / DECIMACAO) + 5;
buf = struct('t', cell(1, N_BUF), 'temp', [], 'setpoint', [], 'erro', [], 'u', [], 'enabled', []);
nb = 0;

stats = struct('lotes', 0, 'falhas', 0, 'rtts', [], 'atrasos', 0);

% Relógio: instante inicial em ms UTC + tempo decorrido medido por tic/toc
t0_ms   = posixtime(datetime('now', 'TimeZone', 'UTC')) * 1000;
relogio = tic;
k = 0;
proximo_passo = Ts;             % instante (s) do próximo passo de controle
proximo_envio = PERIODO_ENVIO;  % instante (s) do próximo envio de lote

% Ao parar (Ctrl+C ou erro): desliga os atuadores e mostra o resumo.
% "encerrar" é uma função aninhada (no fim desta função): enxerga os valores atuais.
limpeza = onCleanup(@encerrar); %#ok<NASGU>

if SIMULACAO
    fprintf("Rodando em SIMULAÇÃO.\n");
else
    fprintf("Rodando com o kit LTR701 (placa %s).\n", DEV_ID);
end
fprintf("Controle DESLIGADO até o site enviar enabled = 1. Ctrl+C para parar.\n\n");

%% ---------------- Laço de controle (100 Hz) ----------------
while true
    % 1. Leitura do sensor, já em °C
    if SIMULACAO
        temp_C = planta.T + 0.15 * randn();
    else
        temp_C = volts_para_celsius(read(dq, "OutputFormat", "Matrix"));
    end

    % 2. Filtro passa-baixa (o mesmo de LCON-I)
    xf1 = xf0;  xf0 = temp_C;
    yf1 = yf0;  yf0 = (xf0 + xf1 - a1*yf1) / a0;
    temp_f = yf0;

    % 3. Controle PI (integrador de Euler) com saturação
    erro = setpoint - temp_f;
    if enabled ~= 1
        integral = 0;    % PDF de LCON-I: flag 0 reinicializa o controlador
        u = 0;
    elseif k < N_AQUEC
        u = 0;           % filtro ainda estabilizando
    else
        integral = integral + erro*Ki*Ts;
        u = min(max(Kp*erro + integral, 0), U_MAX);
    end

    % 4. Atuação
    if SIMULACAO
        planta.T = planta.T + Ts * (-planta.a * (planta.T - planta.T_amb) + planta.b * u);
    else
        write(dq, [u V_VENT]);   % [ao0 = aquecedor, ao1 = ventilador]
    end

    % 5. Guarda amostra decimada
    if mod(k, DECIMACAO) == 0
        nb = nb + 1;
        buf(nb) = struct('t', t0_ms + toc(relogio) * 1000, 'temp', round(temp_f, 3), ...
                         'setpoint', setpoint, 'erro', round(erro, 3), 'u', round(u, 3), ...
                         'enabled', enabled);
    end
    k = k + 1;

    % 6. Uma vez por segundo: envia o lote e recebe os comandos
    % (só envia se houver amostras: nunca manda lote vazio)
    if toc(relogio) >= proximo_envio && nb > 0
        proximo_envio = proximo_envio + PERIODO_ENVIO;
        if proximo_envio < toc(relogio)   % muito atrasado: não acumula envios atrasados
            proximo_envio = toc(relogio) + PERIODO_ENVIO;
        end
        stats.lotes = stats.lotes + 1;

        % num2cell garante que "samples" vire uma lista JSON mesmo com 1 amostra
        payload = struct('device_id', DEVICE_ID, 'samples', {num2cell(buf(1:nb))});
        t_req = tic;
        try
            resp = webwrite(SERVER + "/data", payload, opts);
            stats.rtts(end + 1) = toc(t_req) * 1000;
            enabled  = double(resp.commands.enabled);
            setpoint = double(resp.commands.setpoint);
            fprintf("[ok] %3d amostras  T=%6.2f °C  SP=%5.1f  u=%5.2f V  %s  RTT=%6.1f ms\n", ...
                    nb, temp_f, setpoint, u, ternario(enabled == 1, "ON ", "OFF"), stats.rtts(end));
        catch err
            % Falha de rede NUNCA interrompe o controle: só registra e segue
            stats.falhas = stats.falhas + 1;
            fprintf("[falhou] %s\n", err.message);
        end
        nb = 0;   % começa outro lote (o anterior foi enviado ou perdido)
    end

    % 7. Espera o próximo instante de amostragem
    proximo_passo = proximo_passo + Ts;
    espera = proximo_passo - toc(relogio);
    if espera > 0
        pause(espera);
    else
        stats.atrasos = stats.atrasos + 1;   % passo atrasado (ex.: durante o envio)
        if espera < -0.1
            % Mais de 100 ms atrasado: em vez de rodar vários passos seguidos para
            % "recuperar" (leituras quase simultâneas), retoma o ritmo a partir de agora.
            proximo_passo = toc(relogio);
        end
    end
end

    % ---- Função aninhada: executada automaticamente ao parar o script ----
    function encerrar()
        if ~SIMULACAO && ~isempty(dq)
            try
                write(dq, [0 0]);   % segurança: aquecedor e ventilador desligados
            catch
            end
        end
        fprintf("\n--- Resumo ---\n");
        fprintf("Lotes: %d   falhas: %d   perda: %.1f%%   passos atrasados: %d de %d\n", ...
                stats.lotes, stats.falhas, 100 * stats.falhas / max(stats.lotes, 1), stats.atrasos, k);
        if ~isempty(stats.rtts)
            fprintf("RTT médio: %.1f ms   mín: %.1f ms   máx: %.1f ms\n", ...
                    mean(stats.rtts), min(stats.rtts), max(stats.rtts));
        end
    end
end

%% ================= Funções auxiliares =================

function T = volts_para_celsius(v)
% Conversão do SENSOR 2, obtida em LCON-I
T = 10.29*v + 0.34;
end

function devId = encontrar_placa(devId)
% Se DEV_ID não foi forçado, procura a placa NI conectada (de preferência uma USB-6003).
if strlength(devId) > 0
    return
end
lista = daqlist("ni");
if isempty(lista) || height(lista) == 0
    error("Nenhuma placa NI encontrada. Confira o cabo USB e se a placa aparece no NI MAX. " + ...
          "Para testar sem o kit, use SIMULACAO = true.");
end
modelos = string(lista.Model);
idx = find(contains(modelos, "6003"), 1);
if isempty(idx)
    idx = 1;
end
devId = string(lista.DeviceID(idx));
fprintf("Placa encontrada: %s (%s)\n", devId, modelos(idx));
end

function key = ler_device_key()
% Lê DEVICE_KEY do .env da raiz do repositório (o mesmo usado pelo servidor)
arquivo = fullfile(fileparts(mfilename('fullpath')), '..', '..', '.env');
texto = fileread(arquivo);
tok = regexp(texto, 'DEVICE_KEY=(\S+)', 'tokens', 'once');
if isempty(tok)
    error("DEVICE_KEY não encontrada em %s", arquivo);
end
key = string(tok{1});
end

function s = ternario(cond, a, b)
if cond, s = a; else, s = b; end
end
