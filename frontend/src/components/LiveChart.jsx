// Gráfico de linha com Chart.js, atualizado em tempo real sem redesenhar do zero.
//
// series: [{ label, cor: 'series-1', pontos: [{ x, y }] }]
//   - "cor" é o nome de uma variável CSS (definida em styles.css, com versão para
//     modo claro e escuro), então o gráfico acompanha o tema do sistema.
//   - x = segundos em relação à amostra mais recente (−120 … 0), ou o tempo do
//     ensaio na aba Simulação (eixoX troca o título do eixo).
import { useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';

function cssVar(nome) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${nome}`).trim();
}

// Linha vertical opcional (cursor de tempo), usada pela linha do tempo da aba Simulação
const pluginCursor = {
  id: 'cursor',
  afterDatasetsDraw(chart) {
    const x = chart.options.plugins.cursor?.x;
    if (x === null || x === undefined) return;
    const { ctx, chartArea, scales } = chart;
    const px = scales.x.getPixelForValue(x);
    if (px < chartArea.left || px > chartArea.right) return;
    ctx.save();
    ctx.strokeStyle = cssVar('text-secondary');
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(px, chartArea.top);
    ctx.lineTo(px, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function aplicarTema(chart, series) {
  const texto = cssVar('text-secondary');
  const grade = cssVar('grid');
  series.forEach((s, i) => {
    const ds = chart.data.datasets[i];
    ds.borderColor = cssVar(s.cor);
    ds.backgroundColor = cssVar(s.cor);
  });
  for (const eixo of Object.values(chart.options.scales)) {
    eixo.ticks.color = texto;
    eixo.title.color = texto;
    eixo.grid.color = grade;
    eixo.border = { color: grade };
  }
  chart.options.plugins.legend.labels.color = texto;
}

export default function LiveChart({
  series,
  unidade,
  titulo,
  casas = 2,
  altura = 240,
  eixoX = 'tempo (s) — 0 = agora',
  cursorX = null,
}) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  // Cria o gráfico uma vez
  useEffect(() => {
    const chart = new Chart(canvasRef.current, {
      type: 'line',
      plugins: [pluginCursor],
      data: {
        datasets: series.map((s) => ({
          label: s.label,
          data: [],
          borderWidth: 2, // linha fina
          pointRadius: 0, // sem marcadores (são ~1200 pontos)
          pointHoverRadius: 4,
          tension: 0,
        })),
      },
      options: {
        animation: false, // dados chegam a cada segundo: sem animação, sem "tremido"
        parsing: false,
        normalized: true,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false }, // tooltip segue o mouse no eixo x
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: eixoX },
            ticks: { maxTicksLimit: 7 },
          },
          y: {
            title: { display: true, text: unidade },
            ticks: { maxTicksLimit: 6 },
          },
        },
        plugins: {
          cursor: { x: cursorX },
          legend: { display: series.length > 1, position: 'top', align: 'end', labels: { boxWidth: 12, boxHeight: 2 } },
          tooltip: {
            callbacks: {
              title: (itens) => (itens.length ? `${itens[0].parsed.x.toFixed(1)} s` : ''),
              label: (item) => ` ${item.dataset.label}: ${item.parsed.y.toFixed(casas)} ${unidade}`,
            },
          },
        },
      },
    });
    aplicarTema(chart, series);
    chartRef.current = chart;

    // Se o sistema trocar entre claro/escuro, recolore
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onTema = () => {
      aplicarTema(chart, series);
      chart.update('none');
    };
    media.addEventListener('change', onTema);

    return () => {
      media.removeEventListener('change', onTema);
      chart.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A cada novo lote, só troca os dados
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    series.forEach((s, i) => {
      chart.data.datasets[i].data = s.pontos;
    });
    chart.update('none');
  }, [series]);

  // Cursor de tempo: só redesenha (sem recalcular escalas)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.options.plugins.cursor.x = cursorX;
    chart.draw();
  }, [cursorX]);

  return (
    <figure className="grafico">
      <figcaption>{titulo}</figcaption>
      <div style={{ height: altura }}>
        <canvas ref={canvasRef} role="img" aria-label={titulo} />
      </div>
    </figure>
  );
}
