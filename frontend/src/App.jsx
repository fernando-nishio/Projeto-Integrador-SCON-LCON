// Componente principal: decide entre a tela de login e as páginas do sistema.
// A navegação usa o "#" da URL (#/ = painel, #/simulacao, #/admin = administração), sem biblioteca extra.
import { useEffect, useState } from 'react';
import { api, quandoSessaoExpirar } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Admin from './pages/Admin.jsx';
import Simulacao from './pages/Simulacao.jsx';

function paginaAtual() {
  if (window.location.hash === '#/admin') return 'admin';
  if (window.location.hash === '#/simulacao') return 'simulacao';
  return 'painel';
}

export default function App() {
  const [user, setUser] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [pagina, setPagina] = useState(paginaAtual());
  const [aviso, setAviso] = useState('');

  // Ao abrir o site: já existe uma sessão válida?
  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setCarregando(false));

    quandoSessaoExpirar(() => {
      setUser(null);
      setAviso('Sua sessão expirou. Entre novamente.');
    });

    const onHash = () => setPagina(paginaAtual());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  async function sair() {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setAviso('');
    }
  }

  if (carregando) return <p className="centro muted">Carregando…</p>;

  if (!user) {
    return (
      <Login
        aviso={aviso}
        onLogin={(u) => {
          setUser(u);
          setAviso('');
        }}
      />
    );
  }

  const isAdmin = user.role === 'admin';
  const mostrar = pagina === 'admin' ? (isAdmin ? 'admin' : 'painel') : pagina;

  return (
    <div className="app">
      <header className="topo">
        <div className="marca">
          <strong>Soprador térmico LTR701</strong>
          <span className="muted"> · Projeto Integrador SCOM/LCON</span>
        </div>
        <nav className="abas">
          <a href="#/" className={mostrar === 'painel' ? 'ativa' : ''}>
            Painel
          </a>
          <a href="#/simulacao" className={mostrar === 'simulacao' ? 'ativa' : ''}>
            Simulação
          </a>
          {isAdmin && (
            <a href="#/admin" className={mostrar === 'admin' ? 'ativa' : ''}>
              Administração
            </a>
          )}
        </nav>
        <div className="quem">
          <span>{user.username}</span>
          <span className={`papel ${user.role}`}>{isAdmin ? 'admin' : 'usuário'}</span>
          <button className="btn-link" onClick={sair}>
            Sair
          </button>
        </div>
      </header>

      <main>
        {mostrar === 'admin' ? (
          <Admin user={user} />
        ) : mostrar === 'simulacao' ? (
          <Simulacao />
        ) : (
          <Dashboard user={user} />
        )}
      </main>
    </div>
  );
}
