require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');
const redis   = require('redis');

const app           = express();
const PORT          = process.env.PORT          || 3000;
const CLIENT_ID     = process.env.BLING_CLIENT_ID;
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI  || 'https://painel-bling-ipic.onrender.com/auth/callback';
const CUTOFF        = process.env.CUTOFF        || '12:00';
const REDIS_URL     = process.env.REDIS_URL;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.on('error', err => console.error('Redis error:', err));
redisClient.connect().then(() => console.log('Redis conectado'));

async function getTokens() {
  try {
    const data = await redisClient.get('bling_tokens');
    return data ? JSON.parse(data) : { access_token: null, refresh_token: null, expires_at: null };
  } catch { return { access_token: null, refresh_token: null, expires_at: null }; }
}

async function saveTokens(t) {
  try { await redisClient.set('bling_tokens', JSON.stringify(t)); }
  catch (e) { console.error('Erro ao salvar tokens:', e); }
}

app.get('/auth/login', (req, res) => {
  const url = 'https://api.bling.com.br/Api/v3/oauth/authorize'
    + '?response_type=code'
    + '&client_id=' + CLIENT_ID
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
    + '&scope=pedidos.vendas.leitura'
    + '&state=painel-tv';
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send('<h2>Erro: ' + (error || 'code não recebido') + '</h2>');
  try {
    const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    const resp  = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) return res.send('<h2>Erro: ' + JSON.stringify(data) + '</h2>');
    await saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 });
    console.log('Autenticado!');
    res.redirect('/');
  } catch (e) { res.send('<h2>Erro: ' + e.message + '</h2>'); }
});

async function refreshToken() {
  const t = await getTokens();
  if (!t.refresh_token) return false;
  try {
    const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    const resp  = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) { await saveTokens({ access_token: null, refresh_token: null, expires_at: null }); return false; }
    await saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token || t.refresh_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 });
    console.log('Token renovado');
    return true;
  } catch { return false; }
}

async function ensureToken(req, res, next) {
  const t = await getTokens();
  if (!t.access_token) return res.status(401).json({ error: 'not_authenticated', login_url: '/auth/login' });
  if (Date.now() >= t.expires_at) {
    const ok = await refreshToken();
    if (!ok) return res.status(401).json({ error: 'token_expired', login_url: '/auth/login' });
  }
  req.blingToken = (await getTokens()).access_token;
  next();
}

const LOJAS_ONLINE = new Set([203628722, 203953121, 205397393, 205401394, 206006851, 206029808, 205389906]);
const ID_ABERTO    = 6;

function fmt(d) {
  const br = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return br.toISOString().split('T')[0];
}
function getSituacaoId(o) { return Number((o.situacao && o.situacao.id) || o.situacao || 0); }
function isOnline(o) { return LOJAS_ONLINE.has(Number(o.loja && o.loja.id)); }

async function blingFetch(token, dataInicial, dataFinal) {
  const url  = 'https://api.bling.com.br/Api/v3/pedidos/vendas'
    + '?dataInicial=' + dataInicial
    + '&dataFinal='   + dataFinal
    + '&pagina=1&limite=100';
  const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return (data.data || []).filter(isOnline);
}

app.get('/api/pedidos', ensureToken, async (req, res) => {
  try {
    const hoje   = new Date();
    const ini30  = new Date(hoje); ini30.setDate(ini30.getDate() - 30);
    const token  = req.blingToken;
    const hoje_s = fmt(hoje);

    const todos30 = await blingFetch(token, fmt(ini30), hoje_s);
    const abertos = todos30.filter(o => getSituacaoId(o) === ID_ABERTO);

    try {
      await redisClient.set('baseline:' + hoje_s, JSON.stringify(abertos.map(o => o.numero)), { EX: 7 * 86400 });
    } catch(e) {}

    let numerosComNFhoje = new Set();
    try {
      const cacheKey = 'nf_pedidos:' + hoje_s;
      const cached = await redisClient.get(cacheKey).catch(() => null);

      if (cached) {
        JSON.parse(cached).forEach(n => numerosComNFhoje.add(n));
        console.log('NFs (cache): ' + numerosComNFhoje.size + ' pedidos');
      } else {
        const nfUrl = 'https://api.bling.com.br/Api/v3/nfe'
          + '?dataEmissaoInicial=' + hoje_s + ' 00:00:00'
          + '&dataEmissaoFinal='   + hoje_s + ' 23:59:59'
          + '&pagina=1&limite=100';
        const nfResp = await fetch(nfUrl, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
        const nfData = await nfResp.json();
        const nfs = nfData.data || [];

        const numerosLojaNF = new Set();
        for (const nf of nfs) {
          try {
            await new Promise(r => setTimeout(r, 350));
            const detResp = await fetch('https://api.bling.com.br/Api/v3/nfe/' + nf.id, {
              headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
            });
            const det = await detResp.json();
            const d = det.data || det;
            if (d.pedido && d.pedido.numero) numerosComNFhoje.add(Number(d.pedido.numero));
            if (d.numeroPedido)              numerosComNFhoje.add(Number(d.numeroPedido));
            if (d.numeroPedidoLoja)          numerosLojaNF.add(String(d.numeroPedidoLoja));
          } catch(e) {}
        }

        todos30.forEach(o => {
          if (o.numeroLoja && numerosLojaNF.has(String(o.numeroLoja))) {
            numerosComNFhoje.add(Number(o.numero));
          }
        });

        await redisClient.set(cacheKey, JSON.stringify([...numerosComNFhoje]), { EX: 180 }).catch(() => {});
        console.log('NFs (fresh): ' + nfs.length + ' NFs | ' + numerosComNFhoje.size + ' pedidos');
      }
    } catch(e) {
      console.error('Erro NFs:', e.message);
    }

    const ID_ATENDIDO = 9;
    const todosNaoAbertos = todos30.filter(o => getSituacaoId(o) !== ID_ABERTO);

    const fechados = todosNaoAbertos.filter(o => {
      if (getSituacaoId(o) !== ID_ATENDIDO) return false;
      return numerosComNFhoje.has(Number(o.numero));
    });

    const agPag = todos30.filter(o => getSituacaoId(o) === 15);

    const vistos = new Set();
    const result = [...abertos, ...fechados, ...agPag].filter(o => {
      if (vistos.has(o.numero)) return false;
      vistos.add(o.numero);
      return true;
    });

    console.log('Abertos: ' + abertos.length + ' | Atendidos: ' + fechados.length);
    res.json({ data: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/historico', ensureToken, async (req, res) => {
  try {
    const data_s  = req.query.data || fmt(new Date());
    const pedidos = await blingFetch(req.blingToken, data_s, data_s);
    res.json({ data: pedidos, data_s });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/baseline/popular', ensureToken, async (req, res) => {
  try {
    const hoje  = new Date();
    const ini7  = new Date(hoje); ini7.setDate(ini7.getDate() - 7);
    const todos = await blingFetch(req.blingToken, fmt(ini7), fmt(hoje));
    const porData = {};
    todos.forEach(o => {
      const d = o.data ? o.data.substring(0,10) : '';
      if (!d) return;
      if (!porData[d]) porData[d] = [];
      if (getSituacaoId(o) === ID_ABERTO) porData[d].push(o.numero);
    });
    const salvos = [];
    for (const [data, numeros] of Object.entries(porData)) {
      await redisClient.set('baseline:' + data, JSON.stringify(numeros), { EX: 7 * 86400 });
      salvos.push({ data, total: numeros.length });
    }
    const ontem_s = fmt(new Date(hoje.getTime() - 86400000));
    const todosAbertosOntem = todos.filter(o => getSituacaoId(o) === ID_ABERTO && o.data < fmt(hoje));
    await redisClient.set('baseline:' + ontem_s, JSON.stringify(todosAbertosOntem.map(o => o.numero)), { EX: 7 * 86400 });
    res.json({ ok: true, salvos, baseline_ontem: todosAbertosOntem.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', async (req, res) => {
  const t = await getTokens();
  res.json({ authenticated: !!(t.access_token && Date.now() < (t.expires_at || 0)), login_url: '/auth/login', cutoff: CUTOFF });
});

app.get('/api/debug', ensureToken, async (req, res) => {
  try {
    const hoje = new Date();
    const ini  = new Date(hoje); ini.setDate(ini.getDate() - 7);
    const todos = await blingFetch(req.blingToken, fmt(ini), fmt(hoje));
    const sits  = {};
    todos.forEach(o => {
      const id = getSituacaoId(o);
      if (!sits[id]) sits[id] = { id, total: 0, exemplo: o.numero };
      sits[id].total++;
    });
    res.json(Object.values(sits).sort((a, b) => a.id - b.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-pedido/:numero', ensureToken, async (req, res) => {
  try {
    const hoje  = new Date();
    const ini30 = new Date(hoje); ini30.setDate(ini30.getDate() - 30);
    const todos = await blingFetch(req.blingToken, fmt(ini30), fmt(hoje));
    const pedido = todos.find(o => String(o.numero) === String(req.params.numero));
    res.json(pedido || { erro: 'não encontrado' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-atendidos', ensureToken, async (req, res) => {
  try {
    const hoje   = new Date();
    const ini30  = new Date(hoje); ini30.setDate(ini30.getDate() - 30);
    const token  = req.blingToken;
    const hoje_s = fmt(hoje);
    const todos30 = await blingFetch(token, fmt(ini30), hoje_s);
    const naoAbertos = todos30.filter(o => getSituacaoId(o) !== ID_ABERTO);
    const cacheKey = 'nf_pedidos:' + hoje_s;
    const cached = await redisClient.get(cacheKey).catch(() => null);
    const numerosNF = new Set(cached ? JSON.parse(cached) : []);
    const resultado = naoAbertos
      .filter(o => {
        const saida = (o.dataSaida || '').substring(0, 10);
        return saida === hoje_s || numerosNF.has(Number(o.numero));
      })
      .map(o => ({
        numero:         o.numero,
        numeroLoja:     o.numeroLoja,
        data:           o.data,
        dataSaida:      o.dataSaida,
        situacao:       o.situacao && o.situacao.id || o.situacao,
        loja:           o.loja && o.loja.id,
        unidadeNegocio: o.loja && o.loja.unidadeNegocio && o.loja.unidadeNegocio.id,
        via_dataSaida:  (o.dataSaida || '').substring(0,10) === hoje_s,
        via_nf:         numerosNF.has(Number(o.numero)),
      }));
    res.json({ total: resultado.length, pedidos: resultado, nf_cache: [...numerosNF] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug-nf', ensureToken, async (req, res) => {
  try {
    const hoje_s = fmt(new Date());
    const url = 'https://api.bling.com.br/Api/v3/nfe'
      + '?dataEmissaoInicial=' + hoje_s + ' 00:00:00'
      + '&dataEmissaoFinal='   + hoje_s + ' 23:59:59'
      + '&pagina=1&limite=100';
    const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + req.blingToken, 'Accept': 'application/json' } });
    const data = await resp.json();
    const nfs = data.data || [];
    let detalhe = null;
    if (nfs.length > 0) {
      const dr = await fetch('https://api.bling.com.br/Api/v3/nfe/' + nfs[0].id, {
        headers: { 'Authorization': 'Bearer ' + req.blingToken, 'Accept': 'application/json' }
      });
      detalhe = await dr.json();
    }
    res.json({ total: nfs.length, listagem: nfs[0], detalhe });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cache/limpar', async (req, res) => {
  try {
    const keys = await redisClient.keys('nf_pedidos:*');
    if (keys.length > 0) await redisClient.del(keys);
    res.json({ ok: true, removidos: keys.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log('Servidor na porta ' + PORT));
