// Gráfico de linha com Chart.js, atualizado em tempo real sem redesenhar do zero.
//
// series: [{ label, cor: 'series-1', pontos: [{ x, y }] }]
//   - "cor" é o nome de uma variável CSS (definida em styles.css, com versão para
//     modo claro e escuro), então o gráfico acompanha o tema do sistema.
//   - x = segundos em relação à amostra mais recente (−120 … 0).
import { useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';

function cssVar(nome) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${nome}`).trim();
}

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

export default function LiveChart({ series, unidade, titulo, casas = 2, altura = 240 }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  // Cria o gráfico uma vez
  useEffect(() => {
    const chart = new Chart(canvasRef.current, {
      type: 'line',
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
            title: { display: true, text: 'tempo (s) — 0 = agora' },
            ticks: { maxTicksLimit: 7 },
          },
          y: {
            title: { display: true, text: unidade },
            ticks: { maxTicksLimit: 6 },
          },
        },
        plugins: {
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

  return (
    <figure className="grafico">
      <figcaption>{titulo}</figcaption>
      <div style={{ height: altura }}>
        <canvas ref={canvasRef} role="img" aria-label={titulo} />
      </div>
    </figure>
  );
}
