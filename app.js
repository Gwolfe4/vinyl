(() => {
  const $ = id => document.getElementById(id);
  const REDIRECT = location.origin + location.pathname;
  const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state user-library-read user-library-modify playlist-read-private playlist-read-collaborative';
  const API = 'https://api.spotify.com/v1';
  const store = {
    get(k){ try { return localStorage.getItem('vinyl.'+k); } catch { return null; } },
    set(k,v){ try { v == null ? localStorage.removeItem('vinyl.'+k) : localStorage.setItem('vinyl.'+k, v); } catch {} }
  };
  const flash = (msg, err) => { setStatus(msg, err); clearTimeout(flash.t); flash.t = setTimeout(() => setStatus(''), 3000); };

  // ---------- auth (PKCE) ----------
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  function randomString(n){ const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a).slice(0,n); }

  async function login(id){
    if (!/^[0-9a-f]{32}$/i.test(id || '')) { $('setupErr').textContent = 'That Client ID doesn\'t look right. It should be 32 letters and numbers, copied from your app\'s Settings page.'; return; }
    store.set('clientId', id);
    const verifier = randomString(64);
    store.set('verifier', verifier);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const p = new URLSearchParams({ client_id:id, response_type:'code', redirect_uri:REDIRECT, scope:SCOPES, code_challenge_method:'S256', code_challenge:challenge });
    location.href = 'https://accounts.spotify.com/authorize?' + p;
  }
  async function tokenRequest(body){
    const r = await fetch('https://accounts.spotify.com/api/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error_description || j.error || ('HTTP ' + r.status)); e.code = j.error; throw e; }
    store.set('access', j.access_token);
    store.set('expires', String(Date.now() + (j.expires_in - 60) * 1000));
    if (j.refresh_token) store.set('refresh', j.refresh_token);
  }
  async function handleRedirect(){
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return;
    history.replaceState(null, '', REDIRECT);
    if (q.has('error')) { showSetup('Spotify said: ' + q.get('error') + '. Try connecting again.'); return; }
    try {
      await tokenRequest({ grant_type:'authorization_code', code:q.get('code'), redirect_uri:REDIRECT, client_id:store.get('clientId'), code_verifier:store.get('verifier') });
      store.set('verifier', null);
    } catch (e) { showSetup('Sign-in failed: ' + e.message + '. Check the Client ID and that the redirect address matches exactly.'); }
  }
  // One refresh at a time: Spotify may rotate the refresh token, so parallel refreshes would knock each other out.
  let refreshing = null;
  function accessToken(){
    if (store.get('access') && Date.now() < +store.get('expires')) return Promise.resolve(store.get('access'));
    if (!store.get('refresh')) return Promise.resolve(null);
    if (!refreshing) refreshing = tokenRequest({ grant_type:'refresh_token', refresh_token:store.get('refresh'), client_id:store.get('clientId') })
      .then(() => store.get('access'))
      .catch(e => { if (e.code === 'invalid_grant' || e.code === 'invalid_client') { store.set('access', null); store.set('refresh', null); return null; } return store.get('access') || null; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }
  const signedIn = () => !!store.get('refresh');
  let backoffUntil = 0;
  async function api(method, path, body, retried){
    if (Date.now() < backoffUntil) return new Response(null, { status:429 });
    const t = await accessToken();
    if (!t) { if (!signedIn()) showSetup(); throw new Error('signed out'); }
    const opts = { method, headers:{ Authorization:'Bearer ' + t } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(path.startsWith('http') ? path : API + path, opts);
    if (r.status === 401 && !retried) { store.set('expires', '0'); return api(method, path, body, true); }
    if (r.status === 429) backoffUntil = Date.now() + (+(r.headers.get('Retry-After') || 5)) * 1000;
    return r;
  }
  async function apiError(r){
    try { const j = await r.clone().json(); return (j.error && (j.error.message || j.error)) || ('error ' + r.status); } catch { return 'error ' + r.status; }
  }
  async function getJSON(path){
    const r = await api('GET', path);
    if (!r.ok) { const e = new Error(await apiError(r)); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json();
  }

  // ---------- preferences ----------
  const DEFAULTS = { deck:'walnut', bg:'album', record:'mix', label:'printed', rpm:'33', clock:'off', dim:'off' };
  let prefs = { ...DEFAULTS };
  try { Object.assign(prefs, JSON.parse(store.get('prefs') || '{}')); } catch {}
  if (prefs.record === 'album') prefs.record = 'mix';
  function applyPrefs(){
    const b = document.body.dataset;
    b.deck = prefs.deck; b.bg = prefs.bg; b.record = prefs.record; b.label = prefs.label;
    $('clock').hidden = prefs.clock !== 'on';
    renderLabel(); clockTick(); applyColors(state.art);   // applyColors redraws the record
    store.set('prefs', JSON.stringify(prefs));
  }

  // ---------- album colors ----------
  const colorCache = {};
  function rgb2hsl(r,g,b){ r/=255; g/=255; b/=255; const mx=Math.max(r,g,b), mn=Math.min(r,g,b); let h=0,s=0; const l=(mx+mn)/2;
    if (mx !== mn){ const d=mx-mn; s = l>.5 ? d/(2-mx-mn) : d/(mx+mn); h = mx===r ? (g-b)/d+(g<b?6:0) : mx===g ? (b-r)/d+2 : (r-g)/d+4; h/=6; } return [h,s,l]; }
  function hsl2hex(h,s,l){ const f = n => { const k=(n+h*12)%12, a=s*Math.min(l,1-l); const c=l-a*Math.max(-1,Math.min(k-3,9-k,1)); return Math.round(c*255).toString(16).padStart(2,'0'); }; return '#'+f(0)+f(8)+f(4); }
  const hex = ([r,g,b]) => '#' + [r,g,b].map(v => Math.round(v).toString(16).padStart(2,'0')).join('');
  function analyze(url){
    if (colorCache[url]) return Promise.resolve(colorCache[url]);
    return new Promise(res => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas'); c.width = c.height = 32;
          const x = c.getContext('2d', { willReadFrequently:true }); x.drawImage(img, 0, 0, 32, 32);
          const d = x.getImageData(0, 0, 32, 32).data, buckets = {};
          for (let i = 0; i < d.length; i += 4){
            const r=d[i], g=d[i+1], b=d[i+2], key = (r>>5)+','+(g>>5)+','+(b>>5);
            const bk = buckets[key] || (buckets[key] = { n:0, r:0, g:0, b:0 });
            bk.n++; bk.r+=r; bk.g+=g; bk.b+=b;
          }
          const list = Object.values(buckets).map(bk => { const col=[bk.r/bk.n, bk.g/bk.n, bk.b/bk.n]; const [,s,l]=rgb2hsl(...col); return { col, n:bk.n, s, l, score: bk.n * (0.12 + s * 1.6) * (l < .1 || l > .88 ? .35 : 1) }; })
            .sort((a,b) => b.score - a.score);
          const p = list[0];
          const dist = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
          const q = list.find(e => dist(e.col, p.col) > 70) || p;
          const vivid = (q.s > p.s ? q : p);
          const [h,s] = rgb2hsl(...vivid.col);
          const byL = list.slice(0, 12).slice().sort((a,b) => a.l - b.l);
          const out = { c1:hex(p.col), c2:hex(q.col), c1d:hex(p.col.map(v => v*.45)), accent: vivid.s < .18 ? '#e8b64c' : hsl2hex(h, Math.max(.6, Math.min(.85, s + .2)), .64), ink: p.l > .55 ? '#141414' : '#f1efea',
            pal:{ main:p.col, second:q.col, vivid:vivid.col, dark:byL[0].col, light:byL[byL.length-1].col, lum:list.reduce((t,e) => t + e.l*e.n, 0) / 1024 } };
          colorCache[url] = out; res(out);
        } catch { res(null); }
      };
      img.onerror = () => res(null);
      img.src = url;
    });
  }
  async function applyColors(url){
    const root = document.documentElement.style;
    const c = url ? await analyze(url) : null;
    if (url && url !== state.art) return;
    const v = c || { c1:'#1b1b1d', c2:'#3a3a3e', c1d:'#0e0e10', accent:'#d9d9de', ink:'#e8e8e8', pal:null };
    palette = v.pal; drawDisc();
    root.setProperty('--c1', v.c1); root.setProperty('--c2', v.c2); root.setProperty('--c1d', v.c1d);
    root.setProperty('--c-accent', v.accent); root.setProperty('--label-ink', v.ink);
    // Paint the page canvas too, so any area iOS leaves outside the app (e.g. mid-rotation) matches instead of showing black.
    const ground = prefs.bg === 'album' ? v.c1d : prefs.deck === 'white' ? '#dedcd7' : '#111';
    document.documentElement.style.background = ground;
    const tc = document.querySelector('meta[name=theme-color]'); if (tc) tc.content = ground;
  }

  // ---------- the record itself, drawn on a canvas ----------
  let palette = null, artImg = null;
  const hashStr = str => { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const rgba = (c, a) => 'rgba(' + c.map(v => Math.round(Math.max(0, Math.min(255, v)))).join(',') + ',' + a + ')';
  const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  function withL(c, l){ const [h, s0] = rgb2hsl(...c); const hx = hsl2hex(h, Math.min(s0, .55), l); return [1,3,5].map(i => parseInt(hx.substr(i, 2), 16)); }
  function recordStyle(){
    if (prefs.record !== 'mix') return prefs.record;
    return rng(hashStr((state.art || state.id || 'v') + 'style'))() < .5 ? 'splatter' : 'marble';
  }
  function noiseField(r, oct = 5){
    const G = 64, g = new Float32Array(G * G); for (let i = 0; i < g.length; i++) g[i] = r();
    const sm = t => t * t * (3 - 2 * t);
    const vn = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
      const at = (a, b) => g[((b & 63) * G) + (a & 63)];
      const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
      return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf; };
    return (x, y) => { let v = 0, amp = .5, f = 1; let tot = 0; for (let o = 0; o < oct; o++) { v += vn(x * f, y * f) * amp; tot += amp; f *= 2; amp *= .5; } return v / tot; };
  }
  function drawMarble(x, S, P, r){
    const N = 220, off = document.createElement('canvas'); off.width = off.height = N;
    const ox = off.getContext('2d'), im = ox.createImageData(N, N), d = im.data;
    const fb = noiseField(r, 3), fb2 = noiseField(r, 3), fb3 = noiseField(r, 4);
    const lightAlbum = P.lum > .55;
    const base = withL(P.main, lightAlbum ? .72 : .3), vein = lightAlbum ? withL(P.dark, .14) : withL(P.dark, .06), glow = withL(P.light, lightAlbum ? .92 : .62);
    const ang = r() * Math.PI, ca = Math.cos(ang), sa = Math.sin(ang);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = i / N, v = j / N, ru = u * ca - v * sa, rv = u * sa + v * ca;
      const n = fb(u * 2.2, v * 2.2), n2 = fb2(u * 3 + 3, v * 3 + 7), cloud = fb3(u * 2.4 + 9, v * 2.4 + 2);
      const t1 = Math.abs(Math.sin((ru * 3 + rv * 1.1) * 3.1 + n * 7));
      const t2 = Math.abs(Math.sin((rv * 4 - ru * 1.8) * 2.7 + n2 * 8));
      const v1 = Math.pow(1 - Math.min(1, t1 / .3), 3) * .85, v2 = Math.pow(1 - Math.min(1, t2 / .14), 3) * .5;
      const hl = Math.pow(1 - Math.min(1, Math.abs(Math.sin((ru + rv) * 6 + cloud * 7)) / .18), 3) * .35;
      let c = mixc(base, mixc(base, [0,0,0], .6), Math.max(0, Math.min(1, (.62 - cloud) * 2.2 + .25)));
      c = mixc(c, glow, hl); c = mixc(c, vein, Math.min(1, v1 * .9 + v2));
      const k = (j * N + i) * 4; d[k] = c[0]; d[k+1] = c[1]; d[k+2] = c[2]; d[k+3] = 255;
    }
    ox.putImageData(im, 0, 0);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(off, 0, 0, S, S);
  }
  function drawSplatter(x, S, P, r){
    const R = S / 2, lightAlbum = P.lum > .5;
    const base = withL(mixc(P.light, P.main, .35), lightAlbum ? .86 : .62);
    x.fillStyle = rgba(base, 1); x.fillRect(0, 0, S, S);
    const g = x.createRadialGradient(R * .7, R * .6, R * .1, R, R, R); g.addColorStop(0, 'rgba(255,255,255,.18)'); g.addColorStop(1, 'rgba(0,0,0,.18)'); x.fillStyle = g; x.fillRect(0, 0, S, S);
    const inks = [[withL(P.dark, .08), .62], [withL(P.vivid, .32), .16], [withL(P.second, lightAlbum ? .3 : .22), .12], [withL(P.light, .95), .1]];
    const pick = () => { let t = r(); for (const [c, w] of inks) { if ((t -= w) <= 0) return c; } return inks[0][0]; };
    const streak = (len, w, col, alpha, blur) => {
      x.globalAlpha = alpha; x.fillStyle = rgba(col, 1);
      if (blur) { x.shadowColor = rgba(col, 1); x.shadowBlur = blur; } else x.shadowBlur = 0;
      x.beginPath(); x.moveTo(-len, 0); x.quadraticCurveTo(-len * .1, -w * .9, len * .85, -w);
      x.arc(len * .85, 0, w, -Math.PI / 2, Math.PI / 2); x.quadraticCurveTo(-len * .1, w * .9, -len, 0); x.fill();
    };
    // soft light wisps under everything
    for (let i = 0; i < 90; i++) {
      const a = r() * Math.PI * 2, dist = R * (.42 + .52 * r());
      x.save(); x.translate(R + Math.cos(a) * dist, R + Math.sin(a) * dist); x.rotate(a);
      streak(R * (.03 + .08 * r()), R * (.008 + .01 * r()), withL(P.light, .96), .25 + r() * .2, S * .01);
      x.restore();
    }
    const drops = Math.round(420 + r() * 180);
    for (let i = 0; i < drops; i++) {
      const a = r() * Math.PI * 2, dist = R * (.38 + .58 * Math.pow(r(), .75));
      const len = R * (.012 + .15 * Math.pow(r(), 1.8)), w = R * (.0035 + .009 * Math.pow(r(), 1.5));
      x.save(); x.translate(R + Math.cos(a) * dist, R + Math.sin(a) * dist); x.rotate(a + (r() - .5) * .08);
      streak(len, w, pick(), .75 + r() * .25, 0);
      x.restore();
    }
    x.globalAlpha = 1; x.shadowBlur = 0;
    for (let i = 0; i < 220; i++) {
      const a = r() * Math.PI * 2, dist = R * (.36 + .62 * r());
      x.fillStyle = rgba(pick(), .6 + r() * .4); x.beginPath(); x.arc(R + Math.cos(a) * dist, R + Math.sin(a) * dist, R * (.002 + r() * .005), 0, Math.PI * 2); x.fill();
    }
  }
  function drawGrooves(x, S, r, dark){
    const R = S / 2, step = Math.max(1, S / 650);
    x.lineWidth = Math.max(.6, S / 1400);
    for (let rad = R * .36; rad < R * .975; rad += step) {
      x.strokeStyle = r() < .5 ? 'rgba(0,0,0,' + (dark ? .35 : .08) * r() + ')' : 'rgba(255,255,255,' + (dark ? .05 : .05) * r() + ')';
      x.beginPath(); x.arc(R, R, rad, 0, Math.PI * 2); x.stroke();
    }
    const tracks = 3 + Math.floor(r() * 4);
    for (let i = 0; i < tracks; i++) {
      const rad = R * (.42 + r() * .5);
      x.lineWidth = S * .003; x.strokeStyle = dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.14)';
      x.beginPath(); x.arc(R, R, rad, 0, Math.PI * 2); x.stroke();
    }
    x.lineWidth = S * .02; x.strokeStyle = dark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.12)'; x.beginPath(); x.arc(R, R, R * .345, 0, Math.PI * 2); x.stroke();
    x.lineWidth = S * .012; x.strokeStyle = 'rgba(0,0,0,.35)'; x.beginPath(); x.arc(R, R, R * .992, 0, Math.PI * 2); x.stroke();
    x.lineWidth = S * .003; x.strokeStyle = 'rgba(255,255,255,.18)'; x.beginPath(); x.arc(R, R, R * .978, 0, Math.PI * 2); x.stroke();
  }
  function drawDisc(){
    const cv = $('disc'); if (!cv) return;
    const css = record.clientWidth || 360, S = Math.min(1600, Math.round(css * Math.min(devicePixelRatio || 1, 2.5)));
    if (cv.width !== S) cv.width = cv.height = S;
    const x = cv.getContext('2d'), R = S / 2, r = rng(hashStr(state.art || state.id || 'vinyl'));
    const P = palette || { main:[40,40,44], second:[90,90,96], vivid:[120,120,128], dark:[10,10,12], light:[200,200,205], lum:.2 };
    const style = recordStyle();
    document.body.dataset.record = style;
    x.clearRect(0, 0, S, S); x.save(); x.beginPath(); x.arc(R, R, R, 0, Math.PI * 2); x.clip();
    if (style === 'marble') drawMarble(x, S, P, r);
    else if (style === 'splatter') drawSplatter(x, S, P, r);
    else if (style === 'picture' && artImg && artImg.complete && artImg.naturalWidth) { x.drawImage(artImg, 0, 0, S, S); x.fillStyle = 'rgba(0,0,0,.08)'; x.fillRect(0, 0, S, S); }
    else { x.fillStyle = '#0b0b0d'; x.fillRect(0, 0, S, S); }
    drawGrooves(x, S, r, style === 'black');
    x.restore();
  }
  const redrawSoon = () => { clearTimeout(drawDisc.t); drawDisc.t = setTimeout(drawDisc, 200); };
  addEventListener('resize', redrawSoon);

  // ---------- UI ----------
  const record = $('record'), arm = $('arm'), label = $('label');
  let state = { id:null, playing:false, progress:0, duration:0, at:0, title:'', artist:'', art:null, shuffle:false, repeat:'off', liked:false, isEp:false };

  function fmt(ms){ ms = Math.max(0, ms|0); const s = Math.floor(ms/1000); return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); }
  function setStatus(msg, err){ $('status').textContent = msg || ''; $('status').classList.toggle('err', !!err); }
  function setPlaying(p){
    state.playing = p;
    record.classList.toggle('playing', p);
    arm.classList.toggle('down', p);
    $('playIcon').innerHTML = p ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>';
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
  function renderLabel(){
    if (prefs.label === 'art' && state.art) { const img = new Image(); img.alt = ''; img.src = state.art; label.replaceChildren(img); return; }
    label.innerHTML = '<div class="printed"><div class="pt">' + esc(state.title || 'Vinyl') + '</div><div class="pa">' + esc(state.artist || '') +
      '</div><div class="gap"></div><div class="rpm">' + (prefs.rpm === '45' ? '45 RPM' : '33⅓ RPM') + ' · SIDE A</div></div>';
  }
  // The cover (folded photo + landscape sleeve) updates right away; the record and colors follow its swap animation.
  let coverReady = Promise.resolve();
  const cssUrl = u => 'url("' + String(u).replace(/["\\\n]/g, encodeURIComponent) + '")';
  function renderCover(){
    const art = state.art, sleeve = $('sleeve'), jacket = $('jacket');
    if (!art) { sleeve.replaceChildren(); jacket.replaceChildren(); coverReady = Promise.resolve(); return; }
    const bg = document.createElement('div'); bg.className = 'bg'; bg.style.backgroundImage = cssUrl(art);
    const fr = new Image(); fr.alt = 'Album cover'; fr.className = 'front'; fr.src = art;
    const jk = new Image(); jk.alt = 'Album cover'; jk.src = art;
    const ready = Promise.race([Promise.all([fr, jk].map(i => i.decode ? i.decode().catch(() => {}) : null)), new Promise(r => setTimeout(r, 700))]);
    coverReady = ready.then(() => { if (state.art === art) { sleeve.replaceChildren(bg, fr); jacket.replaceChildren(jk); } });
  }
  function renderRecord(){
    const art = state.art;
    artImg = null;
    if (art) { artImg = new Image(); artImg.onload = () => { if (recordStyle() === 'picture') drawDisc(); }; artImg.src = art; }
    renderLabel(); applyColors(art);
  }
  function renderArt(){ renderCover(); renderRecord(); }
  function swapRecord(){
    renderCover();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !state.prevId) { renderRecord(); return; }
    record.classList.add('swap');
    setTimeout(() => { renderRecord(); record.classList.remove('swap'); record.classList.add('swapin'); setTimeout(() => record.classList.remove('swapin'), 520); }, 450);
  }

  // Every playback change bumps `seq`; a poll that started before the change is ignored.
  let seq = 0, polling = false, expect = null;
  async function poll(){
    if (document.hidden || polling || !signedIn()) return;
    polling = true; const mySeq = seq;
    try {
      const r = await api('GET', '/me/player?additional_types=episode');
      if (mySeq !== seq) return;
      if (r.status === 204) { show(null); return; }
      if (r.status === 429) return;
      if (!r.ok) { setStatus('Couldn\'t reach Spotify (' + await apiError(r) + ').', true); return; }
      const d = await r.json();
      if (mySeq === seq) { show(d); if (pendingSlide && !expect) slideIn(); }
    } catch {} finally { polling = false; }
  }
  const trackInfo = item => {
    const isEp = item.type === 'episode';
    const imgs = isEp ? (item.images || item.show?.images || []) : (item.album?.images || []);
    return { id:item.id, uri:item.uri, title:item.name, isEp, art:imgs[0]?.url || null, duration:item.duration_ms || 0,
      artist: isEp ? (item.show?.name || '') : (item.artists || []).map(a => a.name).join(', ') };
  };
  function setTrack(t){
    if (t.id === state.id) return;
    state.prevId = state.id; Object.assign(state, { id:t.id, title:t.title, artist:t.artist, art:t.art, isEp:t.isEp });
    $('title').textContent = t.title; $('artist').textContent = t.artist;
    swapRecord(); loadLiked(); if (beat.on) loadTempo(t.id, t.isEp);
    slideIn();
  }
  function show(d){
    const item = d && d.item;
    if (d) { setShuffle(!!d.shuffle_state, !!d.smart_shuffle); setRepeat(d.repeat_state || 'off'); $('speaker').classList.toggle('on', !!(d.device && d.device.type !== 'Smartphone')); }
    if (!item) {
      if (state.id !== null) { state.prevId = state.id; state.id = null; state.title = ''; state.artist = ''; state.art = null; swapRecord(); }
      setPlaying(false);
      $('title').textContent = 'Nothing playing'; $('artist').textContent = 'Start a song in the Spotify app';
      $('fill').style.width = '0%'; $('pos').textContent = $('dur').textContent = '0:00'; $('upnext').hidden = true; $('flow').replaceChildren();
      return;
    }
    // After a skip we show the queued song right away; ignore Spotify still reporting the old one for a few seconds.
    if (expect && Date.now() < expect.until && item.id !== expect.id) return;
    if (expect && item.id === expect.id) loadQueue();
    expect = null;
    const t = trackInfo(item);
    if (t.id !== state.id) { setTrack(t); loadQueue(); }
    $('title').textContent = t.title; $('artist').textContent = t.artist;
    state.progress = d.progress_ms || 0; state.duration = t.duration; state.at = performance.now();
    setPlaying(!!d.is_playing);
  }

  let queue = [];
  async function loadQueue(){
    try {
      const q = await getJSON('/me/player/queue');
      queue = (q && q.queue) || [];
      queue.slice(0, 3).forEach(n => { const u = trackInfo(n).art; if (u) new Image().src = u; });
    } catch { queue = []; }
    renderQueue();
  }
  function renderQueue(){
    const n = queue[0];
    renderFlow(queue.slice(0, 3));
    if (!n) { $('upnext').hidden = true; return; }
    const imgs = n.album?.images || n.images || n.show?.images || [];
    const small = imgs[imgs.length - 1]?.url || imgs[0]?.url || '';
    if (small) $('nextArt').src = small; else $('nextArt').removeAttribute('src');
    $('nextTitle').textContent = n.name;
    $('nextArtist').textContent = trackInfo(n).artist;
    $('upnext').hidden = false;
  }
  setInterval(() => { if (state.id && !document.hidden) loadQueue(); }, 20000);
  function renderFlow(items){
    $('flow').replaceChildren(...items.map((n, i) => {
      const imgs = n.album?.images || n.images || n.show?.images || [];
      const url = (imgs[1] || imgs[0] || {}).url || '';
      const el = document.createElement('div'); el.className = 'spine';
      el.innerHTML = (url ? '<div class="sbg"></div><img class="sart" alt="" src="' + esc(url) + '">' : '') +
        '<div class="stxt"><b>' + esc(n.name) + '</b><span>' + esc(trackInfo(n).artist) + '</span></div>';
      if (url) el.querySelector('.sbg').style.backgroundImage = cssUrl(url);
      el.setAttribute('role', 'button'); el.setAttribute('aria-label', 'Up next: ' + n.name + '. Tap to skip ahead.');
      el.onclick = () => skip(i + 1);
      return el;
    }));
  }
  // Skip forward `count` songs, showing the queued song immediately instead of waiting for Spotify.
  async function skip(count = 1){
    const target = queue[count - 1];
    seq++;
    if (target) {
      const t = trackInfo(target);
      expect = { id:t.id, until:Date.now() + 5000 };
      queue = queue.slice(count); renderQueue();
      setTrack(t); state.progress = 0; state.duration = t.duration; state.at = performance.now(); setPlaying(true);
    }
    for (let k = 0; k < count; k++) await control('POST', '/me/player/next', null, null, k < count - 1);
  }
  function previous(){ seq++; control('POST', '/me/player/previous'); }

  const spin = { angle:0, vel:0, last:performance.now(), brake:false };
  function spinFrame(now){
    const dt = Math.min(64, now - spin.last); spin.last = now;
    const target = state.playing && !spin.brake ? 360 / (prefs.rpm === '45' ? 1333 : 1800) : 0;   // degrees per ms
    const ease = spin.brake ? .012 : target > spin.vel ? .0035 : .003;                                // per-ms response
    spin.vel += (target - spin.vel) * Math.min(1, ease * dt);
    if (!target && Math.abs(spin.vel) < 2e-4) spin.vel = 0;
    if (spin.vel) { spin.angle = (spin.angle + spin.vel * dt) % 360; $('spinner').style.transform = 'rotate(' + spin.angle.toFixed(2) + 'deg)'; }
  }
  function tick(){
    const now = performance.now();
    spinFrame(now);
    const live = state.playing ? state.progress + (now - state.at) : state.progress;
    beatFrame(live);
    const pos = scrub.active ? scrub.pos : live;
    if (state.duration) {
      $('fill').style.width = Math.min(100, pos / state.duration * 100) + '%';
      const p = fmt(Math.min(pos, state.duration)), du = fmt(state.duration);
      if (tick.p !== p) { $('pos').textContent = tick.p = p; } if (tick.d !== du) { $('dur').textContent = tick.d = du; }
    }
    requestAnimationFrame(tick);
  }

  async function control(method, path, optimistic, body, quiet){
    seq++;
    if (optimistic) optimistic();
    let ok = false;
    try {
      const r = await api(method, path, body);
      ok = r.ok;
      if (r.status === 403) flash('This needs Spotify Premium. The record display still works.', true);
      else if (r.status === 404) flash('Open the Spotify app on this phone and start a song first.', true);
      else if (r.status === 429) flash('Spotify asked us to slow down. Try again in a moment.', true);
      else if (!r.ok) flash('Spotify didn\'t accept that (' + await apiError(r) + ').', true);
    } catch {}
    if (!quiet) { clearTimeout(control.t); control.t = setTimeout(poll, 700); }
    return ok;
  }
  function togglePlay(){ state.playing ? pause() : play(); }
  $('play').onclick = togglePlay;
  const pause = () => control('PUT', '/me/player/pause', () => { state.progress += performance.now() - state.at; state.at = performance.now(); setPlaying(false); });
  const play = () => control('PUT', '/me/player/play', () => { state.at = performance.now(); setPlaying(true); });

  // Press and hold the record: the platter brakes to a stop and the music pauses. A plain tap still toggles.
  let suppressTap = false;
  (() => {
    const deck = $('deck'); let timer = null, x0 = 0, y0 = 0;
    const cancel = () => { clearTimeout(timer); timer = null; };
    deck.addEventListener('pointerdown', e => {
      if (e.target.closest('.arm')) return;
      x0 = e.clientX; y0 = e.clientY; cancel();
      timer = setTimeout(() => {
        timer = null; suppressTap = true;
        if (state.playing) { spin.brake = true; pause(); flash('Stopped'); if (navigator.vibrate) navigator.vibrate(15); }
      }, 380);
    });
    deck.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 12) cancel(); });
    const up = () => { cancel(); spin.brake = false; };
    deck.addEventListener('pointerup', up); deck.addEventListener('pointercancel', up); deck.addEventListener('pointerleave', up);
    deck.addEventListener('contextmenu', e => e.preventDefault());
    deck.addEventListener('click', e => {
      if (e.target.closest('.arm')) return;
      if (suppressTap) { suppressTap = false; return; }
      togglePlay();
    });
  })();

  // Grab the tonearm: lift it off the record to pause, set it down on the record to play.
  (() => {
    const arm = $('arm'), REST = -16, DOWN = 4, MIN = -26, MAX = 8;
    let drag = null;
    const angleAt = e => {
      const r = arm.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // the rod hangs straight down, rotated 14deg; CSS rotate() turns it clockwise toward the record
      return Math.atan2(-(e.clientX - cx), e.clientY - cy) * 180 / Math.PI - 14;
    };
    const current = () => state.playing ? DOWN : REST;
    arm.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      drag = { start:angleAt(e), from:current(), angle:current(), moved:false };
      arm.classList.add('dragging'); arm.setPointerCapture(e.pointerId);
    });
    arm.addEventListener('pointermove', e => {
      if (!drag) return;
      const a = Math.max(MIN, Math.min(MAX, drag.from + angleAt(e) - drag.start));
      if (Math.abs(a - drag.from) > 1.5) drag.moved = true;
      drag.angle = a; arm.style.transform = 'rotate(' + a.toFixed(1) + 'deg)';
    });
    const release = () => {
      if (!drag) return;
      const { angle, moved } = drag; drag = null;
      arm.classList.remove('dragging'); arm.style.transform = '';
      suppressTap = true; setTimeout(() => { suppressTap = false; }, 350);   // don't let the release count as a tap on the record
      if (!moved) { togglePlay(); return; }                                   // a tap on the arm toggles too
      const onRecord = angle > (REST + DOWN) / 2;
      if (onRecord && !state.playing) play();
      else if (!onRecord && state.playing) pause();
    };
    arm.addEventListener('pointerup', release); arm.addEventListener('pointercancel', release);
    arm.addEventListener('click', e => e.stopPropagation());
  })();
  $('next').onclick = () => skip(1);
  $('prev').onclick = previous;

  // shuffle + repeat
  function setShuffle(on, smart){
    state.shuffle = on; $('shuffle').classList.toggle('on', on); $('shuffle').setAttribute('aria-pressed', String(on));
    $('shuffle').setAttribute('aria-label', on ? (smart ? 'Smart Shuffle is on' : 'Shuffle is on') : 'Shuffle is off');
  }
  // Shuffle and repeat change what plays next, so drop the cached queue and fetch the new order once Spotify has applied it.
  function refreshQueueSoon(){ queue = []; renderQueue(); clearTimeout(refreshQueueSoon.t); refreshQueueSoon.t = setTimeout(loadQueue, 1200); }
  function setRepeat(m){ state.repeat = m; $('repeat').classList.toggle('on', m !== 'off'); $('repeatOne').hidden = m !== 'track'; $('repeat').setAttribute('aria-label', 'Repeat: ' + ({ off:'off', context:'all', track:'this song' }[m])); }
  $('shuffle').onclick = async () => {
    const v = !state.shuffle;
    if (await control('PUT', '/me/player/shuffle?state=' + v, () => setShuffle(v))) { flash(v ? 'Shuffle on' : 'Shuffle off'); refreshQueueSoon(); }
    else setShuffle(!v);
  };
  $('repeat').onclick = () => { const prev = state.repeat, m = { off:'context', context:'track', track:'off' }[state.repeat]; control('PUT', '/me/player/repeat?state=' + m, () => setRepeat(m)).then(ok => ok ? refreshQueueSoon() : setRepeat(prev)); };

  // liked songs
  function setLiked(on){
    state.liked = on; $('heart').classList.toggle('on', on); $('heart').setAttribute('aria-pressed', String(on));
    $('heartPath').setAttribute('d', on ? 'M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2 0 3.6 1.1 4.4 2.6h2C13.8 6.1 15.4 5 17.4 5 21 5 23 8.6 21.6 11.8 19.5 16.4 12 21 12 21z'
      : 'M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2 0 3.6 1.1 4.4 2.6h2C13.8 6.1 15.4 5 17.4 5 21 5 23 8.6 21.6 11.8 19.5 16.4 12 21 12 21zm0-2.4c2.6-1.7 6.6-4.8 7.8-7.6.8-1.9-.3-4-2.4-4-1.5 0-2.6.9-3.3 2.4h-4.2C9.2 7.9 8.1 7 6.6 7c-2.1 0-3.2 2.1-2.4 4 1.2 2.8 5.2 5.9 7.8 7.6z');
  }
  // Apps created after Feb 2026 use /me/library with Spotify URIs; older apps still have /me/tracks.
  async function libraryCall(method, uri){
    const id = uri.split(':').pop();
    const modern = method === 'GET' ? '/me/library/contains?uris=' + encodeURIComponent(uri) : '/me/library?uris=' + encodeURIComponent(uri);
    let r = await api(method, modern);
    if (r.status === 404 || r.status === 405 || r.status === 410) r = await api(method, method === 'GET' ? '/me/tracks/contains?ids=' + id : '/me/tracks?ids=' + id);
    return r;
  }
  async function loadLiked(){
    setLiked(false);
    if (!state.id || state.isEp) return;
    const id = state.id;
    try { const r = await libraryCall('GET', 'spotify:track:' + id); if (r.ok && id === state.id) { const j = await r.json(); setLiked(!!(Array.isArray(j) ? j[0] : j)); } } catch {}
  }
  $('heart').onclick = async () => {
    if (!state.id || state.isEp) return;
    const want = !state.liked; setLiked(want);
    try {
      const r = await libraryCall(want ? 'PUT' : 'DELETE', 'spotify:track:' + state.id);
      if (r.ok) { flash(want ? 'Saved to Liked Songs' : 'Removed from Liked Songs'); return; }
      setLiked(!want);
      const msg = await apiError(r);
      if (/scope/i.test(msg)) openSettings('Spotify needs one more permission for Liked Songs. Tap Reconnect Spotify below.');
      else flash('Couldn\'t update Liked Songs: ' + msg, true);
    } catch { setLiked(!want); }
  };

  // ---------- library: Liked Songs + playlists ----------
  const lib = { tab:'liked', next:null, items:[], playlist:null, view:0 };
  const thumb = imgs => { imgs = imgs || []; return (imgs[imgs.length - 1] || imgs[0] || {}).url || ''; };
  function libRow(img, title, sub, onTap, now){
    const b = document.createElement('button'); b.className = 'libitem' + (now ? ' now' : '');
    b.innerHTML = (img ? '<img alt="" loading="lazy" src="' + esc(img) + '">' : '<span class="ph"></span>') + '<span class="tx"><b>' + esc(title) + '</b><small>' + esc(sub || '') + '</small></span>';
    b.onclick = onTap; return b;
  }
  function libReset(){ lib.view++; lib.next = null; lib.items = []; $('libList').replaceChildren(); $('libMsg').textContent = ''; $('libMore').hidden = true; }
  async function libLoad(path){
    $('libMore').hidden = true;
    const view = lib.view;
    try {
      const j = await getJSON(path);
      if (view !== lib.view) return [];          // the user switched lists while this was loading
      lib.next = j && j.next; $('libMore').hidden = !lib.next;
      return (j && j.items) || [];
    } catch (e) {
      if (view !== lib.view) return [];
      $('libMsg').textContent = e.status === 403 && /scope/i.test(e.message) ? 'Spotify needs one more permission. Open Settings and tap Reconnect Spotify.' : 'Spotify wouldn\'t share this list (' + e.message + ').';
      return [];
    }
  }
  function addTracks(entries, playFrom){
    const rows = [];
    entries.forEach(e => {
      const t = e && (e.item || e.track);           // playlists now return `item`; older responses use `track`
      if (!t || !t.uri || t.is_local) return;
      const i = lib.items.push(t) - 1, info = trackInfo(t);
      rows.push(libRow(thumb(t.album?.images || t.images), info.title, info.artist, () => playFrom(i), t.id === state.id));
    });
    $('libList').append(...rows);
  }
  async function showLiked(path){
    if (!path) { libReset(); lib.tab = 'liked'; lib.playlist = null; }
    addTracks(await libLoad(path || '/me/tracks?limit=50'), i => playUris(lib.items.slice(i, i + 100).map(t => t.uri)));
    if (!lib.items.length && !$('libMsg').textContent) $('libMsg').textContent = 'No Liked Songs yet. Tap the heart on a song to save it.';
  }
  async function showPlaylists(path){
    if (!path) { libReset(); lib.tab = 'playlists'; lib.playlist = null; }
    const rows = (await libLoad(path || '/me/playlists?limit=50')).filter(Boolean).map(pl => {
      const total = (pl.items || pl.tracks || {}).total;
      return libRow(thumb(pl.images), pl.name, (pl.owner?.display_name || '') + (total != null ? ' · ' + total + ' songs' : ''), () => openPlaylist(pl));
    });
    $('libList').append(...rows);
  }
  async function openPlaylist(pl, path){
    if (!path) { libReset(); lib.playlist = pl; $('libTitle').textContent = pl.name; }
    syncLibChrome();
    let entries = await libLoad(path || '/playlists/' + pl.id + '/items?limit=50');
    if (!path && !entries.length && $('libMsg').textContent) { $('libMsg').textContent = ''; entries = await libLoad('/playlists/' + pl.id + '/tracks?limit=50'); }
    addTracks(entries, i => playContext(pl.uri, lib.items[i].uri));
  }
  function syncLibChrome(){
    const inPl = !!lib.playlist;
    $('libActions').hidden = !inPl; $('libTabs').hidden = inPl;
    if (!inPl) $('libTitle').textContent = 'Library';
    [...$('libTabs').children].forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === lib.tab)));
  }
  async function startPlayback(body){
    let r; try { r = await api('PUT', '/me/player/play', body); } catch { return; }
    if (r.ok) { $('library').hidden = true; seq++; setTimeout(poll, 700); refreshQueueSoon(); return; }
    flash(r.status === 404 ? 'Open the Spotify app on this phone first, then try again.' : r.status === 403 ? 'Playing from the library needs Spotify Premium.' : 'Spotify couldn\'t start that (' + await apiError(r) + ').', true);
    $('libMsg').textContent = $('status').textContent;
  }
  const playUris = uris => startPlayback({ uris });
  const playContext = (uri, startUri) => startPlayback(startUri ? { context_uri:uri, offset:{ uri:startUri } } : { context_uri:uri });
  $('libBtn').onclick = () => { if (!signedIn()) { showSetup(); return; } $('library').hidden = false; lib.playlist = null; syncLibChrome(); lib.tab === 'liked' ? showLiked() : showPlaylists(); };
  $('closeLibrary').onclick = () => { $('library').hidden = true; wakeUI(); };
  $('libTabs').onclick = e => { const t = e.target.dataset.tab; if (!t) return; lib.tab = t; syncLibChrome(); t === 'liked' ? showLiked() : showPlaylists(); };
  $('libBack').onclick = () => { lib.playlist = null; syncLibChrome(); showPlaylists(); };
  $('libPlayAll').onclick = () => lib.playlist && playContext(lib.playlist.uri);
  $('libMore').onclick = () => { if (!lib.next) return; lib.playlist ? openPlaylist(lib.playlist, lib.next) : lib.tab === 'liked' ? showLiked(lib.next) : showPlaylists(lib.next); };

  // ---------- speakers ----------
  async function openDevices(){
    $('devices').hidden = false; $('deviceList').innerHTML = '<p>Looking for speakers…</p>';
    try {
      const r = await api('GET', '/me/player/devices'); const j = await r.json();
      const list = j.devices || [];
      if (!list.length) { $('deviceList').innerHTML = '<p>No speakers found.</p>'; return; }
      $('deviceList').replaceChildren(...list.map(dv => {
        const b = document.createElement('button'); b.className = 'device' + (dv.is_active ? ' active' : '');
        b.innerHTML = '<span>' + esc(dv.name) + '<small>' + esc(dv.type) + '</small></span>' + (dv.is_active ? '<span class="dot">Playing here</span>' : '');
        b.onclick = () => { $('devices').hidden = true; control('PUT', '/me/player', null, { device_ids:[dv.id], play:true }); flash('Switching to ' + dv.name); };
        return b;
      }));
    } catch { $('deviceList').innerHTML = '<p>Couldn\'t load speakers.</p>'; }
  }
  $('speaker').onclick = openDevices;
  $('closeDevices').onclick = () => { $('devices').hidden = true; };

  // sleep timer
  let sleepUntil = 0;
  function setSleep(min){
    sleepUntil = min ? Date.now() + min * 60000 : 0;
    sleepTick(); if (min) flash('Music will stop in ' + min + ' minutes.'); renderSettings();
  }
  function sleepTick(){
    const on = sleepUntil > 0;
    $('sleepBtn').classList.toggle('on', on);
    if (on && Date.now() >= sleepUntil) {
      sleepUntil = 0; $('sleepBtn').classList.remove('on'); $('sleepTag').textContent = '';
      if (state.playing) control('PUT', '/me/player/pause', () => setPlaying(false));
      return;
    }
    const left = on ? Math.ceil((sleepUntil - Date.now()) / 60000) : 0;
    $('sleepTag').textContent = on ? left + 'm' : '';
    $('sleepBtn').setAttribute('aria-label', on ? 'Sleep timer: ' + left + ' minutes left' : 'Sleep timer: off');
  }
  setInterval(sleepTick, 5000);
  $('sleepBtn').onclick = () => {
    const steps = [0, 15, 30, 60];
    const cur = sleepUntil ? Math.ceil((sleepUntil - Date.now()) / 60000) : 0;
    const nextMin = steps.find(s => s > cur) || 0;
    if (!nextMin) flash('Sleep timer off');
    setSleep(nextMin);
  };

  // clock + night dim
  function clockTick(){
    const now = new Date();
    if (prefs.clock === 'on') {
      const parts = new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit' }).formatToParts(now);
      const main = parts.filter(p => p.type !== 'dayPeriod').map(p => p.value).join('').trim();
      const ap = parts.find(p => p.type === 'dayPeriod');
      $('clock').innerHTML = esc(main) + (ap ? '<small>' + esc(ap.value) + '</small>' : '');
    }
    const h = now.getHours();
    document.body.classList.toggle('night', prefs.dim === 'on' && (h >= 22 || h < 6));
  }
  setInterval(clockTick, 15000);

  // landscape: hide controls when idle, tap to bring back
  const isLandscape = () => matchMedia('(orientation: landscape) and (min-aspect-ratio: 5/4)').matches && !document.body.classList.contains('folded');
  function wakeUI(){ document.body.classList.remove('idle'); clearTimeout(wakeUI.t); wakeUI.t = setTimeout(() => { if (isLandscape() && $('settings').hidden && $('devices').hidden && $('library').hidden) document.body.classList.add('idle'); }, 5000); }
  document.addEventListener('pointerdown', wakeUI, true);
  $('shield').addEventListener('click', e => { e.stopPropagation(); wakeUI(); });

  // ---------- setup + settings sheets ----------
  function showSetup(err){ $('setup').hidden = false; $('setupErr').textContent = err || ''; $('clientId').value = store.get('clientId') || ''; }
  $('redirect').textContent = REDIRECT;
  $('copyRedirect').onclick = async () => {
    try { await navigator.clipboard.writeText(REDIRECT); $('copyRedirect').textContent = 'Copied'; }
    catch { const s = getSelection(), rg = document.createRange(); rg.selectNodeContents($('redirect')); s.removeAllRanges(); s.addRange(rg); }
  };
  $('connect').onclick = () => login($('clientId').value.trim());

  const SETTINGS = [
    { name:'Turntable', key:'deck', opts:[['walnut','Walnut'],['black','Matte black'],['white','White']] },
    { name:'Background', key:'bg', opts:[['album','Album colors'],['deck','Turntable']] },
    { name:'Record', key:'record', opts:[['mix','Mix (varies by album)'],['splatter','Splatter'],['marble','Marble'],['black','Classic black'],['picture','Picture disc']] },
    { name:'Record label', key:'label', opts:[['printed','Song title'],['art','Album art']] },
    { name:'Spin speed', key:'rpm', opts:[['33','33⅓ RPM'],['45','45 RPM']] },
    { name:'Clock', key:'clock', opts:[['on','Show'],['off','Hide']] },
    { name:'Dim the screen at night (10 PM–6 AM)', key:'dim', opts:[['on','On'],['off','Off']] },
    { name:'Sleep timer', get:() => { if (!sleepUntil) return '0'; const m = Math.ceil((sleepUntil - Date.now()) / 60000); return m > 30 ? '60' : m > 15 ? '30' : '15'; },
      set:v => setSleep(+v), opts:[['0','Off'],['15','15 min'],['30','30 min'],['60','60 min']] },
    { name:'Folded layout', get:() => foldMode, set:v => { foldMode = v; store.set('fold', v); applyFold(); }, opts:[['auto','Automatic'],['on','Always folded'],['off','Always flat']] },
    { name:'Beat pulse', get:() => beat.on ? 'on' : 'off', set:v => { setBeat(v === 'on'); store.set('beat', v === 'on' ? '1' : null); }, opts:[['on','On'],['off','Off']] },
  ];
  function renderSettings(){
    if ($('settings').hidden) return;
    $('settingsList').replaceChildren(...SETTINGS.map(s => {
      const wrap = document.createElement('div'); wrap.className = 'setting';
      const cur = s.get ? s.get() : prefs[s.key];
      wrap.innerHTML = '<div class="name">' + esc(s.name) + '</div>';
      const seg = document.createElement('div'); seg.className = 'seg';
      s.opts.forEach(([v, text]) => {
        const b = document.createElement('button'); b.textContent = text; b.setAttribute('aria-pressed', String(String(cur) === v));
        b.onclick = () => { if (s.set) s.set(v); else { prefs[s.key] = v; applyPrefs(); } renderSettings(); };
        seg.appendChild(b);
      });
      wrap.appendChild(seg); return wrap;
    }));
  }
  function openSettings(msg){ $('settings').hidden = false; $('settingsMsg').textContent = msg || ''; renderSettings(); $('screenInfo').textContent = screenReport(); }
  $('gear').onclick = () => signedIn() ? openSettings() : showSetup();
  $('closeSettings').onclick = () => { $('settings').hidden = true; wakeUI(); };
  $('reconnect').onclick = () => { const id = store.get('clientId'); if (id) login(id); else { $('settings').hidden = true; showSetup('Paste your Client ID to connect again.'); } };
  $('logout').onclick = () => { ['access','refresh','expires','scope'].forEach(k => store.set(k, null)); queue = []; $('settings').hidden = true; show(null); showSetup(); };

  // ---------- swipe on the album art to change songs ----------
  let pendingSlide = null;
  function slideIn(){
    if (!pendingSlide) return;
    const { el, dir } = pendingSlide; pendingSlide = null; clearTimeout(slideIn.t);
    coverReady.then(() => {
      el.classList.add('dragging'); el.style.setProperty('--drag', -dir * innerWidth + 'px');
      requestAnimationFrame(() => requestAnimationFrame(() => { el.classList.remove('dragging'); el.style.setProperty('--drag', '0px'); }));
    });
  }
  function makeSwipe(el){
    let x0 = null, y0 = 0, horiz = null;
    el.addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; horiz = null; }, { passive:true });
    el.addEventListener('touchmove', e => {
      if (x0 === null) return;
      const t = e.touches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horiz = Math.abs(dx) > Math.abs(dy);
      if (horiz) { e.preventDefault(); el.classList.add('dragging'); el.style.setProperty('--drag', dx + 'px'); }
    }, { passive:false });
    const end = e => {
      if (x0 === null) return;
      const dx = (e.changedTouches ? e.changedTouches[0].clientX : x0) - x0;
      el.classList.remove('dragging'); x0 = null;
      if (!(horiz && Math.abs(dx) > 60)) { el.style.setProperty('--drag', '0px'); return; }
      const dir = dx < 0 ? -1 : 1;                       // -1 = next, 1 = previous
      el.style.setProperty('--drag', dir * innerWidth + 'px');
      $('swipeHint').classList.add('gone'); store.set('swiped', '1');
      setTimeout(() => {
        pendingSlide = { el, dir };
        slideIn.t = setTimeout(slideIn, 2500);           // never leave the cover off-screen
        if (dir < 0) skip(1); else previous();
      }, 230);
    };
    el.addEventListener('touchend', end); el.addEventListener('touchcancel', end);
  }
  makeSwipe($('cover')); makeSwipe($('jacket'));
  if (store.get('swiped')) $('swipeHint').classList.add('gone');

  // ---------- beat pulse (song tempo from ReccoBeats; the mic would stop Spotify's audio on iPhone) ----------
  let beat = { on:false, bpm:0, forId:null };
  const tempoCache = {};
  async function loadTempo(id, isEp){
    beat.bpm = 0; beat.forId = id;
    if (!id || isEp) return;
    if (tempoCache[id] === undefined) {
      try {
        const r = await fetch('https://api.reccobeats.com/v1/audio-features?ids=' + encodeURIComponent(id), { headers:{ Accept:'application/json' } });
        const j = await r.json();
        const rec = (j.content && j.content[0]) || (Array.isArray(j) ? j[0] : j);
        const bpm = rec && +rec.tempo;
        tempoCache[id] = bpm > 40 && bpm < 250 ? bpm : 0;
      } catch { tempoCache[id] = 0; }
    }
    if (beat.forId === id) { beat.bpm = tempoCache[id]; if (!beat.bpm) flash('No tempo found for this song, so the pulse is resting.'); }
  }
  function beatFrame(posMs){
    if (!beat.on) return;
    let level = 0;
    if (beat.bpm && state.playing) { const period = 60000 / beat.bpm; level = Math.pow(1 - (posMs % period) / period, 4); }
    document.documentElement.style.setProperty('--beat', level.toFixed(3));
  }
  function setBeat(on){
    beat.on = on; document.body.classList.toggle('pulsing', on); $('beatBtn').setAttribute('aria-pressed', String(on));
    if (on) loadTempo(state.id, state.isEp); else document.documentElement.style.setProperty('--beat', 0);
  }
  $('beatBtn').onclick = () => { setBeat(!beat.on); store.set('beat', beat.on ? '1' : null); flash(beat.on ? 'Pulse on. It follows the song\'s tempo.' : 'Pulse off.'); };

  // ---------- scrub the timeline ----------
  const scrub = { active:false, pos:0 };
  (() => {
    const bar = $('bar');
    const at = e => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * state.duration; };
    bar.addEventListener('pointerdown', e => { if (!state.duration) return; scrub.active = true; scrub.pos = at(e); bar.classList.add('scrubbing'); bar.setPointerCapture(e.pointerId); });
    bar.addEventListener('pointermove', e => { if (scrub.active) scrub.pos = at(e); });
    const done = () => {
      if (!scrub.active) return;
      scrub.active = false; bar.classList.remove('scrubbing');
      const ms = Math.round(scrub.pos); state.progress = ms; state.at = performance.now();
      control('PUT', '/me/player/seek?position_ms=' + ms);
    };
    bar.addEventListener('pointerup', done); bar.addEventListener('pointercancel', done);
    bar.addEventListener('keydown', e => {
      if (!state.duration || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      const live = state.playing ? state.progress + (performance.now() - state.at) : state.progress;
      const ms = Math.max(0, Math.min(state.duration, live + (e.key === 'ArrowRight' ? 10000 : -10000)));
      state.progress = ms; state.at = performance.now(); control('PUT', '/me/player/seek?position_ms=' + Math.round(ms));
    });
  })();

  // ---------- fold layout ----------
  const segMQ = matchMedia('(vertical-viewport-segments: 2)');
  const postureMQ = matchMedia('(device-posture: folded)');
  let foldMode = store.get('fold') || 'auto';
  function hingeFromDevice(){
    const segs = window.viewport && window.viewport.segments;
    if (segs && segs.length === 2 && segs[1].top > segs[0].top) return segs[0].height + 'px';
    return null;
  }
  function deviceFolded(){
    if (segMQ.matches || postureMQ.matches) return true;
    return !!(navigator.devicePosture && navigator.devicePosture.type === 'folded' && innerHeight > innerWidth * 0.9);
  }
  // iOS 26 Home Screen apps (WebKit bug 301108) shorten the viewport while the page is shorter than the screen, and
  // nothing is painted below that edge. Making the page itself screen-tall gets the full viewport back: CSS handles
  // portrait (html.standalone min-height); --screen-h covers landscape, where the status-bar inset is 0.
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (standalone) {
    document.documentElement.classList.add('standalone');
    addEventListener('scroll', () => { if (scrollY) scrollTo(0, 0); }, { passive:true });   // the taller page must never scroll
  }
  function screenHeight(){
    if (!screen.width || !screen.height) return 0;
    return innerWidth > innerHeight ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
  }
  function setAppHeight(){
    const root = document.documentElement.style;
    if (standalone) {
      const full = screenHeight(), diff = full - innerHeight;
      root.setProperty('--screen-h', diff >= 0 && diff <= 160 ? full + 'px' : '0px');   // never trust a wild reading
    }
    const vh = Math.round(Math.max(innerHeight, document.documentElement.clientHeight, (window.visualViewport && visualViewport.height) || 0));
    root.setProperty('--app-h', vh + 'px');
    return vh;
  }
  function screenReport(){
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;bottom:0;left:0;width:1px;visibility:hidden;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe), fixedH = Math.round(probe.getBoundingClientRect().height);
    const out = 'Screen check: window ' + innerWidth + '×' + innerHeight + ' · fixed layer ' + fixedH + ' · screen ' + screen.width + '×' + screen.height +
      ' · page ' + document.documentElement.scrollHeight + ' · safe area ' + parseInt(cs.paddingTop) + '/' + parseInt(cs.paddingBottom) +
      ' · ' + (standalone ? 'Home Screen app' : 'browser tab') + ' · v' + ((document.querySelector('script[src*="app.js"]') || {}).src || '').split('v=')[1];
    probe.remove(); return out;
  }
  if (window.visualViewport) visualViewport.addEventListener('resize', () => { setAppHeight(); applyFold(); });
  function applyFold(){
    const fullH = setAppHeight();
    if (standalone && !applyFold.again) { applyFold.again = true; requestAnimationFrame(() => setTimeout(() => { applyFold.again = false; setAppHeight(); }, 120)); }
    const folded = foldMode === 'on' || (foldMode === 'auto' && deviceFolded());
    document.body.classList.toggle('folded', folded);
    document.documentElement.style.setProperty('--hinge', (folded && hingeFromDevice()) || Math.round(fullH / 2) + 'px');
    $('foldBtn').setAttribute('aria-pressed', String(folded));
    wakeUI();
  }
  $('foldBtn').onclick = () => {
    foldMode = { auto:'on', on:'off', off:'auto' }[foldMode]; store.set('fold', foldMode); applyFold();
    flash({ auto:'Fold layout: automatic (follows your phone when it can)', on:'Fold layout: always folded', off:'Fold layout: always flat' }[foldMode]);
  };
  [segMQ, postureMQ].forEach(m => m.addEventListener && m.addEventListener('change', applyFold));
  if (navigator.devicePosture) navigator.devicePosture.addEventListener('change', applyFold);
  addEventListener('resize', applyFold);
  // iOS can report the pre-rotation size for a moment; measure again once the rotation settles.
  addEventListener('orientationchange', () => { [150, 500, 1000].forEach(ms => setTimeout(() => { applyFold(); redrawSoon(); }, ms)); });

  // keep the screen awake while showing
  async function wake(){ try { if ('wakeLock' in navigator && !document.hidden) await navigator.wakeLock.request('screen'); } catch {} }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); poll(); clockTick(); } });

  // ---------- start ----------
  applyPrefs(); renderArt(); applyFold();
  if (store.get('beat')) setBeat(true);
  (async () => {
    await handleRedirect();
    if (!(await accessToken())) { if ($('setup').hidden) showSetup(); }
    else { $('setup').hidden = true; poll(); }
    setInterval(poll, 3000);
    requestAnimationFrame(tick);
    wake();
  })();
})();
