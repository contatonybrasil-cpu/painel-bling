require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app           = express();
const PORT          = process.env.PORT          || 3000;
const CLIENT_ID     = process.env.BLING_CLIENT_ID;
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI  || 'https://painel-bling.onrender.com/auth/callback';
const CUTOFF        = process.env.CUTOFF        || '12:00';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Tokens em memória
let tokens = { access_token: null, refresh_token: null, expires_at: null };

// STEP 1: Redireciona para login Bling
app.get('/auth/login', (req, res) => {
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize`
    + `?response_type=code`
    + `&client_id=${CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&scope=pedidos.vendas.leitura`
    + `&state=painel-tv`;
  res.redirect(url);
});

// STEP 2: Bling retorna o code aqui
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(`<h2>Erro: ${error || 'code não recebido'}</h2>`);

  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const resp = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Accept':        'application/json',
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data.access_token) {
      return res.send(`<h2>Erro ao obter token: ${JSON.stringify(data)}</h2>`);
    }

    tokens.access_token  = data.access_token;
    tokens.refresh_token = data.refresh_token;
    tokens.expires_at    = Date.now() + (data.expires_in - 60) * 1000;

    console.log('✅ Autenticado com sucesso!');
    res.redirect('/');
  } catch (e) {
    res.send(`<h2>Erro: ${e.message}</h2>`);
  }
});

// Renova token quando expira
async function refreshToken() {
  if (!tokens.refresh_token) return false;
  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const resp = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Accept':        'application/json',
      },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: tokens.refresh_token,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) {
      tokens = { access_token: null, refresh_token: null, expires_at: null };
      return false;
    }
    tokens.access_token  = data.access_token;
    tokens.refresh_token = data.refresh_token || tokens.refresh_token;
    tokens.expires_at    = Date.now() + (data.expires_in - 60) * 1000;
    console.log('🔄 Token renovado');
    return true;
  } catch (e) {
    return false;
  }
}

// Garante token válido antes de cada requisição
async function ensureToken(req, res, next) {
  if (!tokens.access_token) {
    return res.status(401).json({ error: 'not_authenticated', login_url: '/auth/login' });
  }
  if (Date.now() >= tokens.expires_at) {
    const ok = await refreshToken();
    if (!ok) return res.status(401).json({ error: 'token_expired', login_url: '/auth/login' });
  }
  next();
}

// Lojas físicas a ignorar (não aparecem no painel)
const LOJAS_FISICAS = [
  'ecommerce 1',
  'ecommerce 2',
  'new york store multimarcas',
  'prudenshopping - loja 2',
];

function isLojaFisica(o) {
  const loja = (o.loja?.descricao || '').toLowerCase().trim();
  return LOJAS_FISICAS.some(l => loja.includes(l));
}

// Pedidos — busca hoje e ontem, filtra lojas físicas
app.get('/api/pedidos', ensureToken, async (req, res) => {
  try {
    const hoje   = new Date();
    const ontem  = new Date(hoje); ontem.setDate(ontem.getDate() - 1);
    const fmt    = d => d.toISOString().split('T')[0];
    const inicio = req.query.data || fmt(ontem);
    const fim    = fmt(hoje);

    const url = `https://www.bling.com.br/Api/v3/pedidos/vendas`
              + `?dataInicial=${inicio}&dataFinal=${fim}&pagina=1&limite=100`;

    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data });

    // Filtra pedidos das lojas físicas
    const filtrado = {
      ...data,
      data: (data.data || []).filter(o => !isLojaFisica(o)),
    };

    res.json(filtrado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Status / config
app.get('/api/status', (req, res) => {
  res.json({
    authenticated: !!tokens.access_token && Date.now() < (tokens.expires_at || 0),
    login_url: '/auth/login',
    cutoff: CUTOFF,
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Servidor na porta ${PORT}`);
  console.log(`🔑 Autenticar em: /auth/login`);
});
