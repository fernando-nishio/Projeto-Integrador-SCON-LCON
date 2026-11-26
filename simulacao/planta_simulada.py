#!/usr/bin/env python3
"""
Simulador da planta + MATLAB, para testar o backend sem o kit nem o MATLAB.

Faz exatamente o que o script MATLAB (firmware/matlab/cliente_planta.m) faz:
  - laço de controle PI a 100 Hz (Ts = 0,01 s), com os ganhos, a saturação e o
    filtro do script de LCON-I do grupo;
  - guarda 1 amostra a cada DECIMACAO passos (padrão: 10 Hz);
  - a cada 1 s envia o lote para POST /api/data e lê, na própria resposta,
    os comandos { enabled, setpoint };
  - enabled = 0 -> controle desligado, integral zerada, aquecedor em 0 V.

Planta: dT/dt = -0,2351 (T - T_amb) + 1,387 u, ou seja, G(s) = 1,387/(s + 0,2351),
o modelo identificado na Atividade 07 de LCON-I (ajuste de 92,77%), com a
temperatura ambiente (24,4 °C, Parte A) como ponto de equilíbrio. Sem atraso,
como o modelo oficial (o script02 corta os 2,2 s de partida a frio).

Ao apertar Ctrl+C mostra: lotes enviados, perda (%) e RTT médio/mín/máx.

Uso (com o backend rodando):   python3 simulacao/planta_simulada.py
Só usa a biblioteca padrão do Python.
"""

import json
import os
import random
import time
import urllib.error
import urllib.request
from pathlib import Path

# 127.0.0.1 e não "localhost": no Windows, "localhost" tenta primeiro o IPv6 (::1), que o
# Docker não atende, e cada requisição perdia ~2 s esperando antes de cair no IPv4.
SERVER = os.environ.get("SERVER", "http://127.0.0.1:3000/api")
DEVICE_ID = os.environ.get("DEVICE_ID", "LTR701_SIM")

TS = 0.01            # período de amostragem do controle (100 Hz)
DECIMACAO = 10       # guarda 1 a cada 10 amostras -> 10 Hz no banco
PERIODO_ENVIO = 1.0  # envia um lote por segundo

# Planta: modelo da Atividade 07 de LCON-I, G(s) = 1,387/(s + 0,2351)
T_AMB = 24.4
A, B = 0.2351, 1.387  # dT/dt = -A (T - T_AMB) + B u

# Controlador e filtro: mesmos valores do script de LCON-I do grupo (script09)
KP, KI = 1.1, 0.4
U_MAX = 9.5          # saturação do aquecedor (V)
N_AQUEC = 6          # primeiras amostras sem controle, enquanto o filtro estabiliza
TAU = 0.012732395447352          # filtro passa-baixa de 1ª ordem (fc = 12,5 Hz), Tustin
A0, A1 = 1 + 2 * TAU / TS, 1 - 2 * TAU / TS


def ler_device_key():
    if os.environ.get("DEVICE_KEY"):
        return os.environ["DEVICE_KEY"]
    env = Path(__file__).resolve().parent.parent / ".env"
    if env.exists():
        for linha in env.read_text().splitlines():
            if linha.startswith("DEVICE_KEY="):
                return linha.split("=", 1)[1].strip()
    raise SystemExit("DEVICE_KEY não encontrada (nem no ambiente, nem no .env da raiz do repositório)")


DEVICE_KEY = ler_device_key()


def post_lote(amostras):
    """Envia o lote. Devolve (status, resposta, rtt_ms)."""
    corpo = json.dumps({"device_id": DEVICE_ID, "samples": amostras}).encode()
    req = urllib.request.Request(
        f"{SERVER}/data", data=corpo, method="POST",
        headers={"Content-Type": "application/json", "X-Device-Key": DEVICE_KEY},
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=2) as r:
            status, texto = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, texto = e.code, e.read().decode()
    rtt = (time.perf_counter() - t0) * 1000
    try:
        return status, json.loads(texto), rtt
    except json.JSONDecodeError:
        return status, texto, rtt


# Estado
temp = T_AMB          # temperatura "real" da planta
xf0 = xf1 = yf0 = 0.0  # memórias do filtro (como em LCON-I)
temp_f = 0.0          # temperatura filtrada (o que o controle enxerga)
integral = 0.0
enabled, setpoint = 0, 25.0   # até o site mandar outra coisa, controle desligado

buffer = []
lotes = falhas = atrasos = 0
rtts = []
k = 0
print(f"Simulando {DEVICE_ID} -> {SERVER}  (Ctrl+C para parar)")
print("Controle começa DESLIGADO. Ligue pelo site (http://localhost:3000) ou com:\n  docker compose exec backend /backend comando enabled 1\n")

inicio = time.perf_counter()
proximo_passo = inicio + TS              # instante do próximo passo de controle
proximo_envio = inicio + PERIODO_ENVIO   # instante do próximo envio de lote

try:
    while True:
        # 1. Sensor (com ruído) + filtro passa-baixa (o mesmo de LCON-I)
        leitura = temp + random.gauss(0, 0.15)
        xf1, xf0 = xf0, leitura
        yf1, yf0 = yf0, (xf0 + xf1 - A1 * yf0) / A0
        temp_f = yf0

        # 2. Controle PI (ou desligado)
        erro = setpoint - temp_f
        if not enabled:
            integral = 0.0   # PDF de LCON-I: flag 0 reinicializa o controlador
            u = 0.0
        elif k < N_AQUEC:
            u = 0.0          # filtro ainda estabilizando
        else:
            integral += KI * erro * TS
            u = min(max(KP * erro + integral, 0.0), U_MAX)

        # 3. Planta avança um passo (Euler)
        temp += TS * (-A * (temp - T_AMB) + B * u)

        # 4. Guarda a amostra (decimada) com o instante em ms (UTC)
        if k % DECIMACAO == 0:
            buffer.append({
                "t": time.time() * 1000,
                "temp": round(temp_f, 3), "setpoint": setpoint,
                "erro": round(erro, 3), "u": round(u, 3), "enabled": enabled,
            })
        k += 1

        # 5. Uma vez por segundo: envia o lote e recebe os comandos
        agora = time.perf_counter()
        # (só envia se houver amostras: nunca manda lote vazio)
        if agora >= proximo_envio and buffer:
            proximo_envio += PERIODO_ENVIO
            if proximo_envio < agora:   # muito atrasado (servidor lento): não acumula envios atrasados
                proximo_envio = agora + PERIODO_ENVIO
            lotes += 1
            try:
                status, resp, rtt = post_lote(buffer)
                if status == 201:
                    rtts.append(rtt)
                    enabled = int(resp["commands"]["enabled"])
                    setpoint = float(resp["commands"]["setpoint"])
                    print(f"[201] {len(buffer):3d} amostras  T={temp_f:6.2f} °C  SP={setpoint:5.1f}  "
                          f"u={u:5.2f} V  {'ON ' if enabled else 'OFF'}  RTT={rtt:6.1f} ms")
                else:
                    falhas += 1
                    print(f"[{status}] {resp}")
            except (urllib.error.URLError, TimeoutError) as e:
                falhas += 1
                print(f"[falhou] servidor inacessível: {e}")
            buffer = []   # lote enviado (ou perdido): começa outro

        # 6. Espera até o próximo passo de 10 ms
        proximo_passo += TS
        espera = proximo_passo - time.perf_counter()
        if espera > 0:
            time.sleep(espera)
        elif espera < -0.1:
            # Mais de 100 ms atrasado (ex.: servidor demorou a responder): em vez de rodar
            # dezenas de passos de uma vez para "recuperar", retoma o ritmo a partir de agora.
            atrasos += 1
            proximo_passo = time.perf_counter()
except KeyboardInterrupt:
    print("\n--- Resumo ---")
    print(f"Lotes enviados: {lotes}   falhas: {falhas}   perda: {100 * falhas / max(lotes, 1):.1f}%   atrasos > 100 ms: {atrasos}")
    if rtts:
        print(f"RTT médio: {sum(rtts) / len(rtts):.1f} ms   mín: {min(rtts):.1f} ms   máx: {max(rtts):.1f} ms")
