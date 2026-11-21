function cliente_planta()
% CLIENTE_PLANTA  Controle PI do kit LTR701 com troca de dados com o sistema web.
%
% A cada 10 ms (100 Hz): lê a temperatura, filtra, calcula o PI e aplica no aquecedor.
% A cada 1 s: envia um lote de amostras para POST /api/data e lê, na resposta,
%             os comandos do site: enabled (0/1) e setpoint (°C).
%
% Por que em lote? Uma requisição HTTP leva alguns milissegundos. Se fosse feita a
% cada amostra, o laço de 100 Hz atrasaria. Com uma requisição por segundo, no pior
% caso atrasa um único passo por segundo — e esse atraso é medido e mostrado no fim.
%
% SIMULACAO = true  -> roda sem o kit (usa o modelo da planta), para testar em casa.
% SIMULACAO = false -> usa a NI-USB-6003: complete ler_temperatura_volts,
%                      volts_para_celsius e aplicar_aquecedor com o código de LCON-I.
%
% Pressione Ctrl+C para parar: o aquecedor é desligado e um resumo é exibido.

%% ---------------- Configuração ----------------
SIMULACAO     = true;
SERVER        = "http://localhost:3000/api";
DEVICE_ID     = "LTR701_MATLAB";
DEVICE_KEY    = ler_device_key();

Ts            = 0.01;   % período do controle (100 Hz)
DECIMACAO     = 10;     % envia 1 a cada 10 amostras (10 Hz no banco)
PERIODO_ENVIO = 1.0;    % um lote por segundo

Kp = 0.8;  Ki = 0.3;    % ganhos do PI (definidos em LCON-I; NÃO vêm do site)
U_MAX = 10;             % tensão máxima do aquecedor (V)
ALFA  = 0.1;            % filtro passa-baixa: temp_f = ALFA*leitura + (1-ALFA)*temp_f

opts = weboptions( ...
    'MediaType',    'application/json', ...
    'ContentType',  'json', ...                     % resposta vira struct
    'HeaderFields', {'X-Device-Key', char(DEVICE_KEY)}, ...
    'Timeout',      0.5);                           % não trava o laço se o servidor cair

%% ---------------- Hardware ou simulação ----------------
if SIMULACAO
    planta.T = 25; planta.T_amb = 25; planta.a = 0.4; planta.b = 2;   % G(s) = 2/(s+0.4)
    dq = [];
else
    % Exemplo — ajuste canais e configuração conforme o script de LCON-I:
    % dq = daq("ni");
    % addinput(dq,  "Dev1", "ai0", "Voltage");   % sensor de temperatura
    % addoutput(dq, "Dev1", "ao0", "Voltage");   % aquecedor
    error("Configure a NI-USB-6003 (veja os comentários acima) e mude SIMULACAO para true para testar sem o kit.");
end

%% ---------------- Estado ----------------
enabled  = 0;           % começa desligado até o site mandar enabled = 1
setpoint = 25;
integral = 0;
temp_f   = 25;

N_BUF = ceil(PERIODO_ENVIO / Ts / DECIMACAO) + 5;
buf = struct('t', cell(1, N_BUF), 'temp', [], 'setpoint', [], 'erro', [], 'u', [], 'enabled', []);
nb = 0;

stats = struct('lotes', 0, 'falhas', 0, 'rtts', [], 'atrasos', 0);

% Relógio: instante inicial em ms UTC + tempo decorrido medido por tic/toc
t0_ms   = posixtime(datetime('now', 'TimeZone', 'UTC')) * 1000;
relogio = tic;
k = 0;
proximo_envio = PERIODO_ENVIO;

% Ao parar (Ctrl+C ou erro): desliga o aquecedor e mostra o resumo.
% "encerrar" é uma função aninhada (definida no fim desta função), então enxerga
% os valores ATUAIS de stats, dq e SIMULACAO no momento em que o script para.
limpeza = onCleanup(@encerrar); %#ok<NASGU>

fprintf("Rodando (%s). Controle DESLIGADO até o site enviar enabled = 1.\n\n", ...
        ternario(SIMULACAO, "simulação", "kit LTR701"));

%% ---------------- Laço de controle (100 Hz) ----------------
while true
    % 1. Leitura do sensor + filtro
    if SIMULACAO
        leitura = planta.T + 0.15 * randn();
    else
        leitura = volts_para_celsius(ler_temperatura_volts(dq));
    end
    temp_f = ALFA * leitura + (1 - ALFA) * temp_f;

    % 2. Controle PI (flag 0 => reinicializa o controlador, como pede o PDF)
    erro = setpoint - temp_f;
    if enabled == 1
        integral = integral + Ki * erro * Ts;
        u = min(max(Kp * erro + integral, 0), U_MAX);
    else
        integral = 0;
        u = 0;
    end

    % 3. Atuação
    if SIMULACAO
        planta.T = planta.T + Ts * (-planta.a * (planta.T - planta.T_amb) + planta.b * u);
    else
        aplicar_aquecedor(dq, u);
    end

    % 4. Guarda amostra decimada
    if mod(k, DECIMACAO) == 0
        nb = nb + 1;
        buf(nb) = struct('t', t0_ms + toc(relogio) * 1000, 'temp', round(temp_f, 3), ...
                         'setpoint', setpoint, 'erro', round(erro, 3), 'u', round(u, 3), ...
                         'enabled', enabled);
    end
    k = k + 1;

    % 5. Uma vez por segundo: envia o lote e recebe os comandos
    if toc(relogio) >= proximo_envio && nb > 0
        proximo_envio = proximo_envio + PERIODO_ENVIO;
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

    % 6. Espera o próximo instante de amostragem (k * Ts)
    espera = k * Ts - toc(relogio);
    if espera > 0
        pause(espera);
    else
        stats.atrasos = stats.atrasos + 1;   % passo atrasado (ex.: durante o envio)
    end
end

    % ---- Função aninhada: executada automaticamente ao parar o script ----
    function encerrar()
        if ~SIMULACAO && ~isempty(dq)
            aplicar_aquecedor(dq, 0);   % segurança: aquecedor desligado
        end
        fprintf("\n--- Resumo ---\n");
        fprintf("Lotes: %d   falhas: %d   perda: %.1f%%   passos atrasados: %d\n", ...
                stats.lotes, stats.falhas, 100 * stats.falhas / max(stats.lotes, 1), stats.atrasos);
        if ~isempty(stats.rtts)
            fprintf("RTT médio: %.1f ms   mín: %.1f ms   máx: %.1f ms\n", ...
                    mean(stats.rtts), min(stats.rtts), max(stats.rtts));
        end
    end
end

%% ================= Funções auxiliares =================

function key = ler_device_key()
% Lê DEVICE_KEY do backend/.env (o mesmo arquivo usado pelo servidor)
arquivo = fullfile(fileparts(mfilename('fullpath')), '..', '..', 'backend', '.env');
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

% ---- Hardware: complete com o código de LCON-I ----
function v = ler_temperatura_volts(dq)
v = read(dq, "OutputFormat", "Matrix");   % ajuste conforme seu script de LCON-I
end

function T = volts_para_celsius(v)
error("Coloque aqui a equação de conversão Volts -> °C obtida em LCON-I (v = %.3f V).", v);
end

function aplicar_aquecedor(dq, u)
write(dq, u);   % ajuste conforme seu script de LCON-I (ex.: canais do ventilador e aquecedor)
end
