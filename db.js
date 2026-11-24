/* ======================================================================
   NITRO — BASE DE DONNÉES (SQLite dans le navigateur)
   ----------------------------------------------------------------------
   Moteur : SQLite compilé en WebAssembly (sql.js, dossier vendor/).
   Stockage : la base est sauvegardée dans le navigateur (IndexedDB),
   elle survit à la fermeture de la page. Export en fichier .sqlite
   (ouvrable avec « DB Browser for SQLite ») et en CSV.

   Ce qui est enregistré automatiquement :
   - une SESSION commence dès qu'on conduit (vraie voiture via la manette
     USB, ou voiture 3D au clavier / téléphone) et se termine après
     8 s sans commande ;
   - la TÉLÉMÉTRIE : 10 mesures par seconde (angle des roues, vitesse
     PWM, qui conduit) ;
   - les ÉVÉNEMENTS : connexion / déconnexion de la manette, perte de
     liaison, changement de mode, stop vocal, marche arrière, buts,
     klaxon, tours de course ;
   - les TOURS de la course (Labo → Course) avec le temps du pilote.
   ====================================================================== */
(function () {
  'use strict';
  const N = window.__nitro;
  if (!N) return;
  const { G, car, LINK, RACE } = N;

  const IDB_NAME = 'nitro-db', IDB_STORE = 'files', IDB_KEY = 'nitro.sqlite';
  const PILOT_KEY = 'nitro-pilote';
  const SAMPLE_MS = 100;          // 10 mesures par seconde
  const IDLE_END_MS = 8000;       // fin de session après 8 s sans commande
  const SAVE_EVERY_MS = 4000;

  const SCHEMA = `
PRAGMA foreign_keys = ON;

-- Personnes qui conduisent
CREATE TABLE IF NOT EXISTS pilotes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  nom      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  cree_le  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Une session = une période de conduite continue
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pilote_id  INTEGER NOT NULL REFERENCES pilotes(id) ON DELETE CASCADE,
  mode       TEXT    NOT NULL CHECK (mode IN ('manette','miroir','pilote','jeu')),
  debut      TEXT    NOT NULL,
  fin        TEXT,
  duree_s    REAL
);

-- Mesures envoyées à la voiture (10 par seconde)
CREATE TABLE IF NOT EXISTS telemetrie (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  t_ms         INTEGER NOT NULL CHECK (t_ms >= 0),
  angle_deg    INTEGER NOT NULL CHECK (angle_deg BETWEEN 45 AND 135),
  vitesse_pwm  INTEGER NOT NULL CHECK (vitesse_pwm BETWEEN -255 AND 255),
  source       TEXT    NOT NULL CHECK (source IN ('M','W','V','J'))
);
CREATE INDEX IF NOT EXISTS idx_telemetrie_session ON telemetrie(session_id, t_ms);

-- Ce qui se passe pendant la conduite
CREATE TABLE IF NOT EXISTS evenements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  horodatage  TEXT    NOT NULL,
  type        TEXT    NOT NULL CHECK (type IN ('connexion','deconnexion','perte_liaison',
                'mode','stop_vocal','marche_arriere','but','but_contre','klaxon','tour')),
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_evenements_session ON evenements(session_id);

-- Tours de la course (Labo → Course)
CREATE TABLE IF NOT EXISTS tours (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pilote_id   INTEGER NOT NULL REFERENCES pilotes(id) ON DELETE CASCADE,
  session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  temps_s     REAL    NOT NULL CHECK (temps_s > 0),
  date        TEXT    NOT NULL
);

-- La durée est calculée par la base elle-même à la fin d'une session
CREATE TRIGGER IF NOT EXISTS trg_duree_session
AFTER UPDATE OF fin ON sessions
WHEN NEW.fin IS NOT NULL
BEGIN
  UPDATE sessions
     SET duree_s = ROUND((julianday(NEW.fin) - julianday(NEW.debut)) * 86400, 1)
   WHERE id = NEW.id;
END;

-- Résumé de chaque session (calculé à la volée)
CREATE VIEW IF NOT EXISTS v_sessions AS
SELECT s.id,
       p.nom                                              AS pilote,
       s.mode,
       s.debut,
       s.duree_s,
       COUNT(t.id)                                        AS nb_mesures,
       ROUND(AVG(ABS(t.vitesse_pwm)) * 100.0 / 255, 1)    AS vitesse_moy_pct,
       ROUND(MAX(ABS(t.vitesse_pwm)) * 100.0 / 255, 1)    AS vitesse_max_pct,
       ROUND(100.0 * SUM(t.vitesse_pwm < 0) / NULLIF(COUNT(t.id),0), 1) AS recul_pct,
       ROUND(100.0 * SUM(t.angle_deg <> 90) / NULLIF(COUNT(t.id),0), 1) AS virage_pct,
       (SELECT COUNT(*) FROM evenements e WHERE e.session_id = s.id) AS nb_evenements
  FROM sessions s
  JOIN pilotes p        ON p.id = s.pilote_id
  LEFT JOIN telemetrie t ON t.session_id = s.id
 GROUP BY s.id;

-- Classement : meilleur tour de chaque pilote
CREATE VIEW IF NOT EXISTS v_classement AS
SELECT p.nom AS pilote, MIN(t.temps_s) AS meilleur_tour_s, COUNT(*) AS nb_tours
  FROM tours t JOIN pilotes p ON p.id = t.pilote_id
 GROUP BY p.id
 ORDER BY meilleur_tour_s;
`;

  const EXAMPLES = [
    ['Résumé des sessions', 'SELECT * FROM v_sessions ORDER BY id DESC;'],
    ['Temps de conduite par pilote', `SELECT p.nom AS pilote, COUNT(s.id) AS sessions,
       ROUND(SUM(s.duree_s)/60.0, 1) AS minutes
  FROM pilotes p LEFT JOIN sessions s ON s.pilote_id = p.id
 GROUP BY p.id ORDER BY minutes DESC;`],
    ['Vraie voiture vs jeu 3D', `SELECT CASE WHEN mode = 'jeu' THEN 'Jeu 3D' ELSE 'Vraie voiture' END AS type,
       COUNT(*) AS sessions, ROUND(AVG(vitesse_moy_pct),1) AS vitesse_moy_pct
  FROM v_sessions GROUP BY type;`],
    ['Qui conduit ? (joysticks / site / stop)', `SELECT CASE source WHEN 'M' THEN 'joysticks' WHEN 'W' THEN 'site web'
                   WHEN 'V' THEN 'stop vocal' ELSE 'jeu 3D' END AS conducteur,
       COUNT(*) AS mesures,
       ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM telemetrie), 1) AS pourcentage
  FROM telemetrie GROUP BY source ORDER BY mesures DESC;`],
    ['Répartition de la direction', `SELECT CASE WHEN angle_deg < 88 THEN 'gauche'
            WHEN angle_deg > 92 THEN 'droite' ELSE 'tout droit' END AS direction,
       COUNT(*) AS mesures
  FROM telemetrie GROUP BY direction;`],
    ['Événements', `SELECT e.horodatage, e.type, e.detail, e.session_id
  FROM evenements e ORDER BY e.id DESC LIMIT 50;`],
    ['Classement de la course', 'SELECT * FROM v_classement;'],
  ];

  /* ---------------------------------------------------------------- */
  let SQL = null, db = null, ready = false, dirty = false, failed = null;
  const S = { session: null, idleSince: 0, lastSample: 0, lastPwm: 0, lastLinkFresh: false,
              lastLap: null, lastLapStart: 0, lastPort: false };

  const nowIso = () => { const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

  function q(sql, params) { const st = db.prepare(sql); const rows = []; try { st.bind(params || []); while (st.step()) rows.push(st.getAsObject()); } finally { st.free(); } return rows; }
  function one(sql, params) { const r = q(sql, params); return r[0] || null; }
  function run(sql, params) { db.run(sql, params || []); dirty = true; }

  /* ---------- stockage IndexedDB ---------- */
  function idb() { return new Promise((res, rej) => { const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function idbGet() { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); }); }
  async function idbPut(bytes) { const d = await idb(); return new Promise((res, rej) => { const tx = d.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).put(bytes, IDB_KEY); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
  async function persist() { if (!ready || !dirty) return; dirty = false; try { await idbPut(db.export()); } catch (e) { dirty = true; } }

  /* ---------- pilotes ---------- */
  function pilotName() { try { return (localStorage.getItem(PILOT_KEY) || 'Invité').trim() || 'Invité'; } catch (e) { return 'Invité'; } }
  function pilotId(name) { name = (name || 'Invité').trim().slice(0, 30) || 'Invité';
    run('INSERT OR IGNORE INTO pilotes(nom) VALUES (?)', [name]);
    return one('SELECT id FROM pilotes WHERE nom = ?', [name]).id; }

  /* ---------- sessions ---------- */
  function startSession(mode, now) {
    run('INSERT INTO sessions(pilote_id, mode, debut) VALUES (?,?,?)', [pilotId(pilotName()), mode, nowIso()]);
    S.session = { id: one('SELECT last_insert_rowid() AS id').id, mode, t0: now, n: 0 };
    S.lastPwm = 0; refreshLive();
  }
  function endSession() {
    if (!S.session) return;
    const id = S.session.id, n = S.session.n; S.session = null;
    if (n < 5) run('DELETE FROM sessions WHERE id = ?', [id]);       // trop courte : on ne garde pas
    else run('UPDATE sessions SET fin = ? WHERE id = ?', [nowIso(), id]);
    persist(); refreshLive(); if (panelOpen) render();
  }
  function event(type, detail) {
    if (!ready) return;
    run('INSERT INTO evenements(session_id, horodatage, type, detail) VALUES (?,?,?,?)',
        [S.session ? S.session.id : null, nowIso(), type, detail == null ? null : String(detail)]);
    if (panelOpen && tab === 'dash') renderEvents();
  }

  /* ---------- échantillonnage (10 fois par seconde) ---------- */
  function currentInput() {
    // 1) la vraie manette est branchée en USB : c'est elle la source
    if (LINK.port) {
      if (!LINK.fresh()) return { stale: true };   // pas de données récentes : on attend
      const mode = LINK.mode === 'pilot' ? 'pilote' : LINK.mode === 'mirror' ? 'miroir' : 'manette';
      const src = ['M','W','V'].includes(LINK.src) ? LINK.src : 'M';
      return { mode, angle: LINK.ang, pwm: LINK.pwm, src };
    }
    // 2) sinon, la voiture 3D du jeu
    if (G.mode === 'play' && !G.frozen) {
      const angle = Math.max(45, Math.min(135, Math.round(90 - (car.inS || 0) * 45)));
      const t = car.inT || 0, pwm = t === 0 ? 0 : Math.round(Math.sign(t) * Math.min(255, 70 + 185 * Math.abs(t)));
      return { mode: 'jeu', angle, pwm, src: 'J' };
    }
    return null;
  }
  function sample() {
    if (!ready) return;
    const now = performance.now();
    // liaison avec la manette
    const fresh = !!(LINK.port && LINK.fresh());
    if (fresh) { S.lastLinkFresh = true; S.staleSince = 0; S.staleLogged = false; }
    else if (LINK.port && S.lastLinkFresh) {
      if (!S.staleSince) S.staleSince = now;
      if (!S.staleLogged && now - S.staleSince > 1000) { event('perte_liaison', 'aucune donnée de la manette depuis 1 s'); S.staleLogged = true; }
    }
    if (!LINK.port) { S.lastLinkFresh = false; S.staleSince = 0; S.staleLogged = false; }
    // tours de course
    if (RACE.on) {
      if (S.lastLap == null) { S.lastLap = RACE.lap; S.lastLapStart = RACE.lapStart; }
      else if (RACE.lap > S.lastLap && RACE.lapStart && S.lastLapStart) {
        const t = (RACE.lapStart - S.lastLapStart) / 1000;
        if (t > 0) { const nm = (document.getElementById('raceName') && document.getElementById('raceName').value.trim()) || pilotName();
          run('INSERT INTO tours(pilote_id, session_id, temps_s, date) VALUES (?,?,?,?)', [pilotId(nm), S.session ? S.session.id : null, Math.round(t * 100) / 100, nowIso()]);
          event('tour', nm + ' : ' + t.toFixed(2) + ' s'); }
        S.lastLap = RACE.lap; S.lastLapStart = RACE.lapStart;
      } else if (RACE.lap === S.lastLap && RACE.lapStart) S.lastLapStart = RACE.lapStart;
    } else S.lastLap = null;

    let inp = currentInput();
    if (inp && inp.stale) { inp = null; if (S.session && now - S.idleSince > IDLE_END_MS) endSession(); return; }
    const active = inp && (inp.angle !== 90 || inp.pwm !== 0);
    if (S.session && (!inp || inp.mode !== S.session.mode)) endSession();   // la source a changé
    if (!S.session && active) { startSession(inp.mode, now); S.idleSince = now; }
    if (!S.session) return;
    if (active) S.idleSince = now;
    else if (now - S.idleSince > IDLE_END_MS) { endSession(); return; }
    if (!inp) return;
    run('INSERT INTO telemetrie(session_id, t_ms, angle_deg, vitesse_pwm, source) VALUES (?,?,?,?,?)',
        [S.session.id, Math.max(0, Math.round(now - S.session.t0)), inp.angle, inp.pwm, inp.src]);
    if (inp.pwm < 0 && S.lastPwm >= 0) event('marche_arriere', inp.pwm);
    S.lastPwm = inp.pwm; S.session.n++;
    if (S.session.n % 10 === 0) refreshLive();
  }

  /* ---------- branchements sur le site ---------- */
  function hook(name, after) {
    const orig = window[name]; if (typeof orig !== 'function') return;
    window[name] = function () { const r = orig.apply(this, arguments); try { after.apply(this, arguments); } catch (e) {} return r; };
  }
  hook('scoreGoal', side => event(side === 'o' ? 'but' : 'but_contre', side === 'o' ? 'cage orange' : 'cage bleue'));
  hook('voiceStopNow', () => event('stop_vocal', 'mot « stop » entendu'));
  hook('lpMode', m => { if (m !== 'off') event('mode', m === 'pilot' ? 'pilote (site → voiture)' : 'miroir (manette → 3D)'); });
  hook('linkClose', lost => event('deconnexion', lost ? 'manette débranchée' : 'déconnexion'));
  setInterval(() => { const p = !!LINK.port; if (p && !S.lastPort) event('connexion', 'manette USB'); S.lastPort = p; }, 300);
  addEventListener('keydown', e => { if (e.key && e.key.toLowerCase() === 'h' && !e.repeat && G.mode === 'play' && !/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) event('klaxon', 'jeu'); });
  addEventListener('pagehide', () => { if (S.session) endSession(); persist(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) persist(); });

  /* ================================================================
     INTERFACE
     ================================================================ */
  const css = `
#dbChip i{background:#12b5c9}
.dbrec{display:none;width:8px;height:8px;border-radius:50%;background:#f0384b;margin-left:2px;animation:dbp 1s infinite}
.dbrec.on{display:inline-block}@keyframes dbp{50%{opacity:.25}}
.dbwrap{position:fixed;inset:0;z-index:40;background:rgba(10,20,40,.55);display:none;align-items:center;justify-content:center;padding:14px}
.dbwrap.open{display:flex}
.dbbox{background:#fff;color:var(--ink);width:min(1040px,100%);height:min(720px,100%);border-radius:20px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:Inter,system-ui,sans-serif}
.dbh{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line)}
.dbh b{font-family:var(--display);font-weight:400;font-size:21px}
.dbh small{color:var(--muted);font-weight:700;font-size:12px}
.dbh .sp{flex:1}
.dbh button.x{background:var(--mist);color:var(--ink);border-radius:10px;width:32px;height:32px;font-weight:900}
.dbtabs{display:flex;gap:4px;padding:8px 14px 0;border-bottom:1px solid var(--line);overflow-x:auto}
.dbtabs button{padding:9px 14px;border-radius:10px 10px 0 0;font-weight:800;font-size:13px;color:var(--muted);white-space:nowrap}
.dbtabs button.on{background:var(--mist);color:var(--ink)}
.dbbody{flex:1;overflow:auto;padding:16px 18px;background:var(--mist)}
.dbsec{display:none}.dbsec.on{display:block}
.dbrow{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.dbkpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
.dbkpi{background:#fff;border-radius:14px;padding:12px}
.dbkpi b{display:block;font-family:var(--display);font-weight:400;font-size:26px;color:var(--ink)}
.dbkpi span{font-size:12px;color:var(--muted);font-weight:700}
.dbcard{background:#fff;border-radius:14px;padding:12px 14px;margin-bottom:12px}
.dbcard h4{margin:0 0 8px;font-size:14px}
.dbgrid{display:grid;grid-template-columns:1.6fr 1fr;gap:12px}
.dblive{display:flex;align-items:center;gap:8px;font-weight:800;font-size:13px;background:#fff;border-radius:12px;padding:9px 12px}
.dblive i{width:10px;height:10px;border-radius:50%;background:#9aa6b8}.dblive.on i{background:#f0384b;animation:dbp 1s infinite}
.dbin{border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:inherit;font-weight:700;background:#fff;color:var(--ink)}
.dbbtn{background:var(--ink);color:#fff;border-radius:10px;padding:8px 13px;font-weight:800;font-size:13px}
.dbbtn.alt{background:#fff;color:var(--ink);border:1px solid var(--line)}
.dbbtn.red{background:#f0384b}
.dbt{width:100%;border-collapse:collapse;font-size:12.5px;background:#fff}
.dbt th{background:var(--ink);color:#fff;text-align:left;padding:7px 9px;font-weight:700;position:sticky;top:0}
.dbt td{white-space:nowrap;padding:6px 9px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
.dbt tr.sel td{background:#fff4ea}
.dbscroll{max-height:360px;overflow:auto;border-radius:12px}
.dbev{font-size:12.5px;max-height:250px;overflow:auto}
.dbev div{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--line)}
.dbev em{font-style:normal;font-weight:800;min-width:110px}
.dbev small{color:var(--muted);min-width:58px}
.dbsql{width:100%;min-height:120px;font-family:var(--mono);font-size:13px;border:1px solid var(--line);border-radius:12px;padding:10px;background:#0f1830;color:#e6ebf5;resize:vertical}
.dbex{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.dbex button{background:#fff;border:1px solid var(--line);border-radius:999px;padding:5px 10px;font-size:12px;font-weight:700}
.dbmsg{font-size:12.5px;font-weight:700;color:var(--muted);margin:6px 0}
.dbmsg.err{color:#c0182b}
.dbcode{font-family:var(--mono);font-size:11.5px;background:#0f1830;color:#e6ebf5;border-radius:12px;padding:12px;white-space:pre;overflow:auto;max-height:300px}
.dbnote{font-size:12.5px;color:var(--muted);line-height:1.5}
canvas.dbchart{width:100%;height:200px;display:block}
@media (max-width:760px){.dbkpis{grid-template-columns:repeat(2,1fr)}.dbgrid{grid-template-columns:1fr}.dbbox{height:100%}}
`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const chip = document.createElement('button');
  chip.className = 'chip shadow'; chip.id = 'dbChip'; chip.title = 'Base de données de conduite';
  chip.innerHTML = '<i></i><span class="lbl">Données</span><span class="dbrec" id="dbRec"></span>';
  const lab = document.getElementById('labChip');
  if (lab && lab.parentNode) lab.parentNode.insertBefore(chip, lab.nextSibling); else document.body.appendChild(chip);

  const wrap = document.createElement('div'); wrap.className = 'dbwrap'; wrap.id = 'dbWrap';
  wrap.innerHTML = `
<div class="dbbox" role="dialog" aria-label="Base de données NITRO">
  <div class="dbh"><div><b>Base de données</b><br><small>SQLite · enregistrée dans ce navigateur</small></div><span class="sp"></span>
    <div class="dblive" id="dbLive"><i></i><span id="dbLiveTxt">Pas de session en cours</span></div>
    <button class="x" id="dbX" aria-label="Fermer">✕</button></div>
  <div class="dbtabs" role="tablist">
    <button data-dt="dash" class="on">Tableau de bord</button><button data-dt="sess">Sessions</button>
    <button data-dt="sql">Requêtes SQL</button><button data-dt="schema">Schéma</button><button data-dt="io">Export</button></div>
  <div class="dbbody">
    <section class="dbsec on" data-ds="dash">
      <div class="dbrow"><label style="font-weight:800;font-size:13px">Pilote</label>
        <input class="dbin" id="dbPilot" maxlength="30" style="width:180px">
        <span class="dbnote">Conduisez (vraie voiture en USB, ou voiture 3D au clavier) : tout s'enregistre tout seul.</span></div>
      <div class="dbkpis" id="dbKpis"></div>
      <div class="dbgrid">
        <div class="dbcard"><h4 id="dbChartT">Dernière session</h4><canvas class="dbchart" id="dbChart"></canvas>
          <div class="dbnote"><b style="color:#ff7a1a">━</b> vitesse (% de la PWM max) &nbsp; <b style="color:#1f7cff">━</b> angle des roues (45° à 135°)</div></div>
        <div class="dbcard"><h4>Derniers événements</h4><div class="dbev" id="dbEv"></div></div>
      </div>
    </section>
    <section class="dbsec" data-ds="sess">
      <div class="dbrow"><span class="dbnote">Résumé calculé par la vue <b>v_sessions</b>. Cliquez une ligne pour voir sa courbe.</span></div>
      <div class="dbscroll"><table class="dbt" id="dbSessT"></table></div>
      <div class="dbcard" style="margin-top:12px"><h4 id="dbChart2T">Session</h4><canvas class="dbchart" id="dbChart2"></canvas></div>
    </section>
    <section class="dbsec" data-ds="sql">
      <textarea class="dbsql" id="dbSql" spellcheck="false"></textarea>
      <div class="dbex" id="dbEx"></div>
      <div class="dbrow"><button class="dbbtn" id="dbRun">Exécuter (Ctrl + Entrée)</button><span class="dbmsg" id="dbMsg"></span></div>
      <div class="dbscroll"><table class="dbt" id="dbRes"></table></div>
    </section>
    <section class="dbsec" data-ds="schema">
      <div class="dbcard"><h4>Modèle relationnel</h4><div id="dbEr"></div></div>
      <div class="dbcard"><h4>Script SQL de création</h4><div class="dbcode" id="dbDdl"></div></div>
    </section>
    <section class="dbsec" data-ds="io">
      <div class="dbcard"><h4>Exporter</h4>
        <div class="dbrow"><button class="dbbtn" id="dbExp">Télécharger la base (.sqlite)</button>
          <button class="dbbtn alt" id="dbCsv">Télémétrie (.csv)</button><button class="dbbtn alt" id="dbCsvS">Sessions (.csv)</button></div>
        <p class="dbnote">Le fichier .sqlite s'ouvre avec <b>DB Browser for SQLite</b> (gratuit) : on y retrouve les mêmes tables, vues et données.</p></div>
      <div class="dbcard"><h4>Importer</h4>
        <div class="dbrow"><input type="file" id="dbFile" accept=".sqlite,.db"><button class="dbbtn alt" id="dbImp">Remplacer la base par ce fichier</button></div>
        <p class="dbnote">Pour récupérer une base enregistrée sur un autre ordinateur.</p></div>
      <div class="dbcard"><h4>Remise à zéro</h4>
        <div class="dbrow"><button class="dbbtn red" id="dbReset">Effacer toutes les données</button><span class="dbmsg" id="dbResetMsg"></span></div></div>
      <p class="dbnote" id="dbInfo"></p>
    </section>
  </div>
</div>`;
  document.body.appendChild(wrap);
  const $ = id => document.getElementById(id);

  let panelOpen = false, tab = 'dash', selSession = null;
  function openPanel() { panelOpen = true; wrap.classList.add('open'); render(); }
  function closePanel() { panelOpen = false; wrap.classList.remove('open'); }
  chip.onclick = () => (panelOpen ? closePanel() : openPanel());
  $('dbX').onclick = closePanel;
  wrap.addEventListener('click', e => { if (e.target === wrap) closePanel(); });
  // les touches tapées dans le panneau ne doivent pas piloter la voiture
  wrap.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closePanel(); });
  wrap.addEventListener('keyup', e => e.stopPropagation());
  wrap.querySelectorAll('[data-dt]').forEach(b => b.onclick = () => { tab = b.dataset.dt;
    wrap.querySelectorAll('[data-dt]').forEach(x => x.classList.toggle('on', x === b));
    wrap.querySelectorAll('[data-ds]').forEach(s => s.classList.toggle('on', s.dataset.ds === tab)); render(); });

  $('dbPilot').value = pilotName();
  $('dbPilot').onchange = e => { const v = e.target.value.trim().slice(0, 30) || 'Invité'; e.target.value = v;
    try { localStorage.setItem(PILOT_KEY, v); } catch (x) {} if (ready) { pilotId(v); persist(); } };

  function refreshLive() {
    const on = !!S.session; $('dbRec').classList.toggle('on', on); $('dbLive').classList.toggle('on', on);
    const lbl = { manette: 'vraie voiture', miroir: 'vraie voiture (miroir)', pilote: 'vraie voiture (pilote)', jeu: 'jeu 3D' };
    $('dbLiveTxt').textContent = failed ? 'Base indisponible' : !ready ? 'Chargement…' : on
      ? `Enregistrement · session #${S.session.id} · ${lbl[S.session.mode]} · ${S.session.n} mesures` : 'Pas de session en cours';
    if (panelOpen && tab === 'dash') renderKpis();
  }

  function table(el, rows, cols) {
    if (!rows.length) { el.innerHTML = '<tr><td style="color:var(--muted)">Aucune ligne.</td></tr>'; return; }
    cols = cols || Object.keys(rows[0]);
    el.innerHTML = '<tr>' + cols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr>' +
      rows.map(r => '<tr>' + cols.map(c => `<td>${esc(r[c])}</td>`).join('') + '</tr>').join('');
  }

  function renderKpis() {
    const k = one(`SELECT (SELECT COUNT(*) FROM sessions) s, (SELECT COUNT(*) FROM telemetrie) m,
      (SELECT COALESCE(SUM(duree_s),0) FROM sessions) d, (SELECT MIN(temps_s) FROM tours) b,
      (SELECT COUNT(*) FROM sessions WHERE mode <> 'jeu') r`);
    const mins = k.d / 60;
    $('dbKpis').innerHTML = [
      [k.s, `sessions (${k.r} vraie voiture)`], [k.m.toLocaleString('fr-FR'), 'mesures de télémétrie'],
      [mins < 1 ? Math.round(k.d) + ' s' : mins.toFixed(1).replace('.', ',') + ' min', 'de conduite enregistrée'],
      [k.b ? k.b.toFixed(2).replace('.', ',') + ' s' : '–', 'meilleur tour (course)']
    ].map(([b, s]) => `<div class="dbkpi"><b>${b}</b><span>${s}</span></div>`).join('');
  }
  function renderEvents() {
    const ev = q('SELECT horodatage, type, detail FROM evenements ORDER BY id DESC LIMIT 40');
    const nm = { connexion: '🔌 connexion', deconnexion: '⏏ déconnexion', perte_liaison: '⚠ perte liaison', mode: '🔁 mode',
      stop_vocal: '🎙 stop vocal', marche_arriere: '↩ marche arrière', but: '⚽ but', but_contre: '⚽ contre son camp', klaxon: '📯 klaxon', tour: '🏁 tour' };
    $('dbEv').innerHTML = ev.length ? ev.map(e => `<div><small>${esc(e.horodatage.slice(11))}</small><em>${esc(nm[e.type] || e.type)}</em><span>${esc(e.detail || '')}</span></div>`).join('')
      : '<div class="dbnote">Aucun événement pour l\'instant.</div>';
  }
  function drawChart(canvas, sid) {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.max(10, r.width * dpr); canvas.height = Math.max(10, r.height * dpr);
    const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); const W = r.width, H = r.height;
    c.clearRect(0, 0, W, H);
    const rows = sid ? q('SELECT t_ms, angle_deg, vitesse_pwm FROM telemetrie WHERE session_id = ? ORDER BY t_ms', [sid]) : [];
    c.font = '12px Inter,sans-serif'; c.fillStyle = '#5a6b85';
    if (!rows.length) { c.fillText('Pas encore de données : conduisez quelques secondes.', 12, H / 2); return; }
    const L = 34, R = 34, T = 10, B = 22, tw = Math.max(1, rows[rows.length - 1].t_ms);
    const x = t => L + (W - L - R) * t / tw, yV = v => T + (H - T - B) * (1 - (v + 100) / 200), yA = a => T + (H - T - B) * (1 - (a - 45) / 90);
    c.strokeStyle = '#d7e3ef'; c.lineWidth = 1;
    [-100, -50, 0, 50, 100].forEach(v => { c.beginPath(); c.moveTo(L, yV(v)); c.lineTo(W - R, yV(v)); c.stroke(); c.fillText(v + '%', 2, yV(v) + 4); });
    [45, 90, 135].forEach(a => c.fillText(a + '°', W - R + 4, yA(a) + 4));
    c.fillText('0 s', L, H - 5); c.textAlign = 'right'; c.fillText((tw / 1000).toFixed(1) + ' s', W - R, H - 5); c.textAlign = 'left';
    const line = (f, col) => { c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); rows.forEach((p, i) => { const X = x(p.t_ms), Y = f(p); i ? c.lineTo(X, Y) : c.moveTo(X, Y); }); c.stroke(); };
    line(p => yA(p.angle_deg), '#1f7cff'); line(p => yV(p.vitesse_pwm * 100 / 255), '#ff7a1a');
  }
  function renderDash() {
    renderKpis(); renderEvents();
    const last = one('SELECT id, mode, debut FROM sessions ORDER BY id DESC LIMIT 1');
    $('dbChartT').textContent = last ? `Dernière session · #${last.id} · ${last.mode} · ${last.debut}` : 'Dernière session';
    drawChart($('dbChart'), last && last.id);
  }
  function renderSessions() {
    const rows = q('SELECT * FROM v_sessions ORDER BY id DESC LIMIT 200');
    const el = $('dbSessT'); table(el, rows);
    if (rows.length) {
      const trs = el.querySelectorAll('tr');
      rows.forEach((r, i) => { const tr = trs[i + 1]; tr.style.cursor = 'pointer'; if (r.id === selSession) tr.classList.add('sel');
        const td = document.createElement('td'); td.innerHTML = '<button class="dbbtn alt" style="padding:3px 8px">Supprimer</button>';
        td.firstChild.onclick = ev => { ev.stopPropagation(); run('DELETE FROM sessions WHERE id = ?', [r.id]); persist(); if (selSession === r.id) selSession = null; renderSessions(); };
        tr.appendChild(td); tr.onclick = () => { selSession = r.id; renderSessions(); }; });
      trs[0].appendChild(document.createElement('th'));
      if (selSession == null) selSession = rows[0].id;
    }
    const s = selSession && one('SELECT id, pilote, mode, debut, duree_s FROM v_sessions WHERE id = ?', [selSession]);
    $('dbChart2T').textContent = s ? `Session #${s.id} · ${s.pilote} · ${s.mode} · ${s.debut} · ${s.duree_s ?? '…'} s` : 'Session';
    drawChart($('dbChart2'), s && s.id);
  }
  function runSql() {
    const sql = $('dbSql').value.trim(); if (!sql) return;
    const msg = $('dbMsg'); msg.classList.remove('err');
    try {
      const t0 = performance.now(); const res = db.exec(sql); const ms = (performance.now() - t0).toFixed(1);
      const ch = db.getRowsModified(); if (ch) { dirty = true; persist(); }
      const last = res[res.length - 1];
      if (last) { const rows = last.values.map(v => Object.fromEntries(last.columns.map((c, i) => [c, v[i]])));
        table($('dbRes'), rows.slice(0, 500), last.columns);
        msg.textContent = `${last.values.length} ligne(s) · ${ms} ms` + (last.values.length > 500 ? ' (500 affichées)' : ''); }
      else { $('dbRes').innerHTML = ''; msg.textContent = `Requête exécutée · ${ch} ligne(s) modifiée(s) · ${ms} ms`; }
    } catch (e) { msg.classList.add('err'); msg.textContent = 'Erreur SQL : ' + e.message; $('dbRes').innerHTML = ''; }
  }
  $('dbRun').onclick = runSql;
  $('dbSql').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); } });
  $('dbEx').innerHTML = EXAMPLES.map((e, i) => `<button data-ex="${i}">${esc(e[0])}</button>`).join('');
  $('dbEx').querySelectorAll('button').forEach(b => b.onclick = () => { $('dbSql').value = EXAMPLES[+b.dataset.ex][1]; runSql(); });
  $('dbSql').value = EXAMPLES[0][1];

  $('dbDdl').textContent = SCHEMA.trim();
  $('dbEr').innerHTML = `<svg viewBox="0 0 860 392" width="100%" style="max-height:420px">
  <defs><marker id="dbm" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10" fill="none" stroke="#10213b" stroke-width="1.5"/></marker></defs>
  ${[['pilotes', 20, 20, ['🔑 id', 'nom (unique)', 'cree_le']],
     ['sessions', 300, 20, ['🔑 id', '🔗 pilote_id', 'mode', 'debut', 'fin', 'duree_s (trigger)']],
     ['telemetrie', 600, 20, ['🔑 id', '🔗 session_id', 't_ms', 'angle_deg (45–135)', 'vitesse_pwm (±255)', 'source (M/W/V/J)']],
     ['evenements', 600, 200, ['🔑 id', '🔗 session_id', 'horodatage', 'type', 'detail']],
     ['tours', 20, 170, ['🔑 id', '🔗 pilote_id', '🔗 session_id', 'temps_s', 'date']]].map(([n, x, y, f]) =>
    `<g><rect x="${x}" y="${y}" width="230" height="${30 + f.length * 19}" rx="10" fill="#fff" stroke="#10213b"/>
     <rect x="${x}" y="${y}" width="230" height="26" rx="10" fill="#10213b"/><text x="${x + 12}" y="${y + 18}" fill="#fff" font-weight="800" font-size="13">${n}</text>
     ${f.map((t, i) => `<text x="${x + 12}" y="${y + 44 + i * 19}" font-size="12" fill="#10213b">${esc(t)}</text>`).join('')}</g>`).join('')}
  <g stroke="#10213b" stroke-width="1.5" fill="none" font-size="11">
    <path d="M250,55 L298,55" marker-end="url(#dbm)"/><text x="256" y="48" fill="#5a6b85" stroke="none">1 — n</text>
    <path d="M530,55 L598,55" marker-end="url(#dbm)"/><text x="540" y="48" fill="#5a6b85" stroke="none">1 — n</text>
    <path d="M530,120 L565,120 L565,240 L598,240" marker-end="url(#dbm)"/><text x="570" y="185" fill="#5a6b85" stroke="none">1 — n</text>
    <path d="M135,105 L135,168" marker-end="url(#dbm)"/><text x="140" y="140" fill="#5a6b85" stroke="none">1 — n</text>
    <path d="M300,140 L270,140 L270,230 L252,230" marker-end="url(#dbm)"/><text x="275" y="190" fill="#5a6b85" stroke="none">0..1 — n</text>
  </g>
  <text x="20" y="350" font-size="12" fill="#5a6b85">Vues : v_sessions (résumé par session), v_classement (meilleur tour par pilote)</text>
  <text x="20" y="368" font-size="12" fill="#5a6b85">Trigger : trg_duree_session calcule duree_s quand la session se termine</text>
  <text x="20" y="386" font-size="12" fill="#5a6b85">Suppression en cascade : effacer une session efface ses mesures et ses événements</text>
  </svg>`;

  function download(name, data, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
  function csv(rows) { if (!rows.length) return ''; const cols = Object.keys(rows[0]); const f = v => v == null ? '' : /[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    return '﻿' + cols.join(';') + '\n' + rows.map(r => cols.map(c => f(r[c])).join(';')).join('\n'); }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  $('dbExp').onclick = () => download(`nitro-${stamp()}.sqlite`, db.export(), 'application/vnd.sqlite3');
  $('dbCsv').onclick = () => download(`nitro-telemetrie-${stamp()}.csv`, csv(q('SELECT * FROM telemetrie ORDER BY id')), 'text/csv');
  $('dbCsvS').onclick = () => download(`nitro-sessions-${stamp()}.csv`, csv(q('SELECT * FROM v_sessions ORDER BY id')), 'text/csv');
  $('dbImp').onclick = async () => {
    const f = $('dbFile').files[0]; if (!f) { $('dbInfo').textContent = 'Choisissez d\'abord un fichier .sqlite.'; return; }
    try { const nd = new SQL.Database(new Uint8Array(await f.arrayBuffer())); nd.exec(SCHEMA); nd.exec('SELECT COUNT(*) FROM sessions');
      if (S.session) endSession(); db.close(); db = nd; dirty = true; await persist(); $('dbInfo').textContent = 'Base importée.'; render(); }
    catch (e) { $('dbInfo').textContent = 'Fichier invalide : ' + e.message; }
  };
  let resetArm = 0;
  $('dbReset').onclick = async () => {
    if (Date.now() - resetArm > 4000) { resetArm = Date.now(); $('dbResetMsg').textContent = 'Cliquez encore une fois pour confirmer.'; return; }
    resetArm = 0; if (S.session) S.session = null; db.close(); db = new SQL.Database(); db.exec(SCHEMA); dirty = true; await persist();
    $('dbResetMsg').textContent = 'Base vidée.'; refreshLive(); render();
  };

  function render() {
    if (!panelOpen) return;
    if (!ready) { $('dbKpis').innerHTML = `<div class="dbkpi"><b>…</b><span>${failed ? esc(failed) : 'Chargement de SQLite…'}</span></div>`; return; }
    if (tab === 'dash') renderDash(); else if (tab === 'sess') renderSessions(); else if (tab === 'sql') { if (!$('dbRes').innerHTML) runSql(); }
    else if (tab === 'io') { const k = one('SELECT (SELECT COUNT(*) FROM sessions) s, (SELECT COUNT(*) FROM telemetrie) m');
      $('dbInfo').textContent = `Contenu actuel : ${k.s} sessions, ${k.m} mesures · taille ${(db.export().length / 1024).toFixed(0)} Ko · SQLite ${one('SELECT sqlite_version() AS v').v}`; }
  }

  /* ---------- démarrage ---------- */
  (async () => {
    try {
      const base = new URL('vendor/', document.currentScript ? document.currentScript.src : location.href).href;
      await new Promise((res, rej) => { if (window.initSqlJs) return res(); const s = document.createElement('script'); s.src = base + 'sql-wasm.js'; s.onload = res; s.onerror = () => rej(new Error('sql-wasm.js introuvable')); document.head.appendChild(s); });
      SQL = await window.initSqlJs({ locateFile: f => base + f });
      let bytes = null; try { bytes = await idbGet(); } catch (e) {}
      db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
      db.exec(SCHEMA);
      ready = true; pilotId(pilotName()); dirty = true; persist();
      setInterval(() => { try { sample(); } catch (e) { console.warn('[NITRO DB]', e); } }, SAMPLE_MS); setInterval(persist, SAVE_EVERY_MS);
      refreshLive(); render();
    } catch (e) { failed = 'Base indisponible : ' + e.message; refreshLive(); render(); }
  })();

  window.__nitroDB = { q: (s, p) => ready ? q(s, p) : [], state: S, persist, open: openPanel, ready: () => ready };
})();
