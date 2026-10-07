import { CATALOGUE } from './catalogue.js';
import { ouvrirBase } from './store.js';

// ------------------------------------------------------------------ Outils
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lire = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const normaliser = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');

const SITE = 'https://anycreations.github.io/mes-collections-bd/';
const LIEN_APK = 'https://github.com/anycreations/CollectionSPG-telechargement/releases/latest/download/CollectionSPG.apk';
const LIBELLES = { possede: "Je l'ai", remplacer: "Je l'ai mais en mauvais état", manquant: "Je ne l'ai pas !" };
const COURTS = { possede: "Je l'ai", remplacer: 'En mauvais état', manquant: "Je ne l'ai pas" };
const SIGNES = { possede: '✓', remplacer: '↻', manquant: '✕' };

// ------------------------------------------------------------------ État
const S = {
  base: null,
  ecran: 'chargement',          // chargement | accueil | collections | collection
  groupe: lire('mcb-groupe', null),
  prenom: lire('mcb-prenom', ''),
  mesGroupes: lire('mcb-groupes', []),
  reglages: { spgTotal: null, docs: {} },
  numeros: {},                  // id collection → { n: fiche }
  col: null,                    // collection ouverte
  filtre: 'tous', recherche: '',
  vue: lire('mcb-vue', 'liste'),
  decroissant: lire('mcb-ordre', true),
  ecoutes: [],
};

/** Liste des collections du groupe (catalogue + collections créées). */
/** Collection du catalogue qui remplace une ancienne collection perso du même nom, ou undefined. */
const remplacante = (d) => d.perso && CATALOGUE.find((c) => c.alias && String(d.nom || '').toLowerCase().includes(c.alias));

function collections() {
  const docs = S.reglages.docs || {};
  const liste = CATALOGUE.map((c) => ({
    ...c, perso: false,
    total: c.id === 'spg' ? (S.reglages.spgTotal || c.total) : (docs[c.id]?.total || c.total),
  }));
  Object.entries(docs).filter(([, d]) => d.perso && !remplacante(d))
    .sort((a, b) => (a[1].creeLe?.seconds || 0) - (b[1].creeLe?.seconds || 0))
    .forEach(([id, d]) => liste.push({ id, nom: d.nom, court: d.nom, total: d.total || 1, couvertures: 0, perso: true, couleur: '#5D4037' }));
  return liste;
}
const colParId = (id) => collections().find((c) => c.id === id);

function etatDe(col, n) { return S.numeros[col]?.[n]?.etat || 'manquant'; }
function compter(c) {
  let pos = 0, rem = 0;
  for (let n = 1; n <= c.total; n++) { const e = etatDe(c.id, n); if (e === 'possede') pos++; else if (e === 'remplacer') rem++; }
  return { pos, rem, possedes: pos + rem, manquants: c.total - pos - rem };
}
function couverture(c, n) {
  const perso = S.numeros[c.id]?.[n]?.couverture;
  if (perso) return perso;
  return n <= (c.couvertures || 0) ? `couv/${c.id}/${n}.jpg` : null;
}

// ------------------------------------------------------------------ Connexion au groupe
function arreterEcoutes() { S.ecoutes.forEach((u) => u()); S.ecoutes = []; S.numeros = {}; }

const migrees = new Set();
function ouvrirGroupe(code) {
  arreterEcoutes();
  S.groupe = code; ecrire('mcb-groupe', code);
  if (!S.mesGroupes.includes(code)) { S.mesGroupes = [code, ...S.mesGroupes].slice(0, 10); ecrire('mcb-groupes', S.mesGroupes); }
  S.ecran = 'collections';
  const surErreur = () => toast('La liste ne se met plus à jour. Vérifie ta connexion puis recharge la page.');
  const suivies = new Set();
  const suivre = (id) => {
    if (suivies.has(id)) return; suivies.add(id);
    S.ecoutes.push(S.base.ecouterNumeros(code, id, (f) => { S.numeros[id] = f; rendre(); }, surErreur));
  };
  S.ecoutes.push(S.base.ecouterCollections(code, (r) => {
    S.reglages = r; collections().forEach((c) => suivre(c.id)); rendre();
    // Une collection créée à la main (ex. « Fantomiald ») devient la collection intégrée, avec ses couvertures.
    Object.entries(r.docs || {}).forEach(([id, d]) => {
      const cible = remplacante(d); if (!cible || migrees.has(id)) return; migrees.add(id);
      const total = (d.total || 0) > cible.total ? d.total : null;
      S.base.migrerCollection(code, id, cible.id, total).catch(() => migrees.delete(id));
    });
  }, surErreur));
  collections().forEach((c) => suivre(c.id));
  rendre();
}

function quitterGroupe() {
  arreterEcoutes(); S.groupe = null; ecrire('mcb-groupe', null);
  S.ecran = 'accueil'; S.col = null; rendre();
}

// ------------------------------------------------------------------ Affichage
const app = $('#app');

function rendre() {
  document.body.dataset.ecran = S.ecran;
  if (S.ecran === 'chargement') { app.innerHTML = '<p class="vide">Chargement…</p>'; return; }
  if (S.ecran === 'accueil') return rendreAccueil();
  if (S.ecran === 'collections') return rendreCollections();
  if (S.ecran === 'collection') return rendreCollection();
}

// --- Accueil : prénom + code de groupe
let attenteCreation = null;
function rendreAccueil() {
  const anciens = S.mesGroupes.length
    ? `<section class="bloc"><h3>Mes groupes</h3><div class="puces">${S.mesGroupes.map((g) =>
        `<button class="puce" data-a="groupe" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div></section>` : '';
  const confirmation = attenteCreation ? `
    <div class="alerte" role="alert">
      <p>Le groupe <b>${esc(attenteCreation)}</b> n'existe pas. Vérifie l'orthographe du code : une lettre inversée suffit à ouvrir un autre groupe.</p>
      <div class="rang"><button class="btn plein" data-a="creerGroupe">Créer ce nouveau groupe</button><button class="btn" data-a="corriger">Corriger le code</button></div>
    </div>` : '';
  app.innerHTML = `
    <header class="entete-accueil">
      <h1>Mes Collections BD</h1>
      <p class="sous">Suis tes collections en famille ou entre amis : tout le monde voit la même liste.</p>
    </header>
    <form class="bloc formulaire" id="f-accueil">
      <label for="i-prenom">Ton prénom</label>
      <input id="i-prenom" autocomplete="given-name" value="${esc(S.prenom)}" required>
      <label for="i-code">Code du groupe</label>
      <input id="i-code" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ex. SPG-ABC123" value="${esc(attenteCreation || '')}" required minlength="6">
      <p class="aide">Saisis le code qu'on t'a donné. Pour démarrer un nouveau groupe, invente un code (6 caractères minimum).</p>
      ${confirmation}
      <button class="btn plein grand" type="submit" ${attenteCreation ? 'hidden' : ''}>Ouvrir</button>
    </form>
    ${anciens}
    ${S.base?.demo ? '<p class="aide centre">Mode démonstration : essaie le code <b>DEMO-PICSOU</b>.</p>' : ''}`;
  $('#f-accueil').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const prenom = $('#i-prenom').value.trim(); const code = normaliser($('#i-code').value);
    if (!prenom || code.length < 6) return;
    S.prenom = prenom; ecrire('mcb-prenom', prenom);
    try {
      if (await S.base.groupeExiste(code)) { attenteCreation = null; ouvrirGroupe(code); }
      else { attenteCreation = code; rendreAccueil(); }
    } catch (e) { toast("Connexion impossible. Vérifie ta connexion Internet et réessaie."); }
  });
}

// --- Écran des collections en vignettes
function rendreCollections() {
  const tuiles = collections().map((c) => {
    const k = compter(c);
    const img = couverture(c, 1);
    const pc = c.total ? Math.round(k.possedes / c.total * 100) : 0;
    return `<button class="tuile" data-a="ouvrirCol" data-id="${esc(c.id)}" style="--teinte:${c.couleur}">
      <span class="tuile-image">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : `<span class="sans-image">${esc(c.court)}</span>`}</span>
      <span class="tuile-nom">${esc(c.nom)}</span>
      <span class="tuile-jauge"><i class="v" style="width:${k.pos / c.total * 100}%"></i><i class="o" style="width:${k.rem / c.total * 100}%"></i></span>
      <span class="tuile-chiffres"><b>${k.possedes}</b> / ${c.total} · ${pc} %</span>
    </button>`;
  }).join('');
  app.innerHTML = `
    <header class="barre-haut">
      <div><p class="groupe">Groupe ${esc(S.groupe)}</p><h1>Mes Collections BD</h1></div>
      <button class="btn-icone" data-a="reglagesGroupe" aria-label="Réglages">⚙</button>
    </header>
    <div class="tuiles">${tuiles}
      <button class="tuile nouvelle" data-a="nouvelleCol"><span class="plus">+</span><span class="tuile-nom">Nouvelle collection</span></button>
    </div>`;
}

// --- Une collection
let lignes = {}, colConstruite = null;
function construireListe(c) {
  const pile = $('#pile'); pile.textContent = ''; lignes = {};
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= c.total; n++) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'num'; b.dataset.n = n; b.dataset.a = 'fiche';
    const img = couverture(c, n);
    b.innerHTML = `<span class="couv">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : n}</span>
      <span class="txt"><span class="n">N° ${n}</span><span class="e"></span></span><span class="pastille"></span>`;
    lignes[n] = b; frag.appendChild(b);
  }
  pile.appendChild(frag); colConstruite = c.id + ':' + c.total;
}

function rendreCollection() {
  const c = colParId(S.col);
  if (!c) { S.ecran = 'collections'; return rendre(); }
  if (!$('#pile') || document.body.dataset.col !== c.id) {
    document.body.dataset.col = c.id;
    app.innerHTML = `
      <header class="barre-haut collante">
        <button class="btn-icone" data-a="retour" aria-label="Retour aux collections">←</button>
        <button class="btn-icone" data-a="accueil" aria-label="Accueil">⌂</button>
        <div class="titres"><p class="groupe">Groupe ${esc(S.groupe)}</p><h1>${esc(c.nom)}</h1></div>
        <button class="btn-icone" data-a="vue" id="b-vue"></button>
        <button class="btn-icone" data-a="ordre" id="b-ordre" aria-label="Inverser l'ordre">⇅</button>
        <button class="btn-icone" data-a="reglagesCol" aria-label="Réglages de la collection">⚙</button>
        <div class="compteurs">
          <button class="compteur c-possede" data-a="filtre" data-f="possedes"><b id="k-pos">0</b><span>Je l'ai</span></button>
          <button class="compteur c-remplacer" data-a="filtre" data-f="remplacer"><b id="k-rem">0</b><span>En mauvais état</span></button>
          <button class="compteur c-manquant" data-a="filtre" data-f="manquants"><b id="k-man">0</b><span>Je ne l'ai pas</span></button>
        </div>
        <div class="jauge"><i class="v" id="j-v"></i><i class="o" id="j-o"></i></div>
        <div class="resume"><span id="resume"></span><span id="filtre-actif"></span></div>
        <input id="recherche" type="search" inputmode="numeric" placeholder="Chercher un numéro" value="${esc(S.recherche)}">
      </header>
      <div id="pile"></div>
      <p class="vide" id="vide" hidden>Aucun numéro ne correspond.</p>
      <div class="rail" id="rail" aria-hidden="true"><span class="curseur" id="curseur"></span><span class="bulle" id="bulle" hidden></span></div>`;
    $('#recherche').addEventListener('input', (e) => { S.recherche = e.target.value.replace(/\D/g, ''); rendreCollection(); });
    colConstruite = null;
  }
  if (colConstruite !== c.id + ':' + c.total) construireListe(c);

  const q = S.recherche.trim(); let visibles = 0;
  for (let n = 1; n <= c.total; n++) {
    const e = etatDe(c.id, n), b = lignes[n];
    if (b.dataset.etat !== e) {
      b.dataset.etat = e; b.querySelector('.e').textContent = LIBELLES[e]; b.querySelector('.pastille').textContent = SIGNES[e];
      b.setAttribute('aria-label', `Numéro ${n}, ${LIBELLES[e]}`);
    }
    const img = couverture(c, n), cv = b.querySelector('.couv');
    if (img && cv.querySelector('img')?.getAttribute('src') !== img) cv.innerHTML = `<img src="${esc(img)}" alt="" loading="lazy">`;
    const ok = (S.filtre === 'tous' || (S.filtre === 'possedes' && e !== 'manquant') || (S.filtre === 'remplacer' && e === 'remplacer') || (S.filtre === 'manquants' && e === 'manquant'))
      && (!q || String(n).includes(q));
    b.hidden = !ok; if (ok) visibles++;
    b.style.order = S.decroissant ? c.total - n : n;
  }
  const k = compter(c);
  $('#k-pos').textContent = k.possedes; $('#k-rem').textContent = k.rem; $('#k-man').textContent = k.manquants;
  $('#j-v').style.width = (k.pos / c.total * 100) + '%'; $('#j-o').style.width = (k.rem / c.total * 100) + '%';
  $('#resume').textContent = `${k.possedes} sur ${c.total} numéros (${Math.round(k.possedes / c.total * 100)} %)`;
  const noms = { possedes: "Je l'ai", remplacer: 'En mauvais état', manquants: "Je ne l'ai pas" };
  $('#filtre-actif').textContent = S.filtre === 'tous' ? '' : `Filtre : ${noms[S.filtre]} (${visibles}) · touche à nouveau pour tout voir`;
  document.querySelectorAll('.compteur').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === S.filtre)));
  $('#pile').classList.toggle('grille', S.vue === 'grille');
  $('#b-vue').textContent = S.vue === 'grille' ? '☰' : '▦';
  $('#b-vue').setAttribute('aria-label', S.vue === 'grille' ? 'Afficher en liste' : 'Afficher en vignettes');
  $('#vide').hidden = visibles > 0;
  majRail();
  if (ficheOuverte) rendreFiche();
}

// --- Barre de défilement rapide
function elementsVisibles() { return [...document.querySelectorAll('#pile .num:not([hidden])')].sort((a, b) => a.style.order - b.style.order); }
function majRail() {
  const rail = $('#rail'); if (!rail) return;
  const max = document.documentElement.scrollHeight - innerHeight;
  rail.hidden = max < innerHeight;
  const f = max > 0 ? scrollY / max : 0;
  $('#curseur').style.top = `calc(${f} * (100% - 56px))`;
}
addEventListener('scroll', () => { if (S.ecran === 'collection' && !glisse) majRail(); }, { passive: true });
let glisse = false;
function suivreRail(y) {
  const rail = $('#rail').getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (y - rail.top - 28) / (rail.height - 56)));
  const els = elementsVisibles(); if (!els.length) return;
  const el = els[Math.round(f * (els.length - 1))];
  scrollTo({ top: f * (document.documentElement.scrollHeight - innerHeight) });
  $('#curseur').style.top = `calc(${f} * (100% - 56px))`;
  const b = $('#bulle'); b.hidden = false; b.textContent = `N° ${el.dataset.n}`; b.style.top = `calc(${f} * (100% - 56px))`;
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#rail')) return;
  glisse = true; e.target.closest('#rail').setPointerCapture(e.pointerId); suivreRail(e.clientY); e.preventDefault();
});
document.addEventListener('pointermove', (e) => { if (glisse) suivreRail(e.clientY); });
const finRail = () => { if (!glisse) return; glisse = false; const b = $('#bulle'); if (b) b.hidden = true; };
document.addEventListener('pointerup', finRail); document.addEventListener('pointercancel', finRail);

// ------------------------------------------------------------------ Fenêtres
const dlg = $('#dlg'), dlgCorps = $('#dlg-corps');
function ouvrirFenetre(html) { dlgCorps.innerHTML = html; if (!dlg.open) dlg.showModal(); }
dlg.addEventListener('close', () => { ficheOuverte = null; });
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

// --- Fiche d'un numéro
let ficheOuverte = null;
function rendreFiche() {
  const c = colParId(S.col), n = ficheOuverte, f = S.numeros[c.id]?.[n] || {}, e = f.etat || 'manquant';
  const img = couverture(c, n);
  const titre = c.titres?.[n];
  const quand = f.le ? new Date(f.le).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).replace(' ', ' à ') : '';
  const lienWiki = c.id === 'spg' ? `<a class="lien" href="https://picsou.fandom.com/fr/wiki/Super_Picsou_G%C3%A9ant_n%C2%B0${n}" target="_blank" rel="noopener">Voir sur le wiki Picsou ↗</a>` : '';
  ouvrirFenetre(`
    <h2>${esc(c.court)} n° ${n}</h2>
    ${titre ? `<p class="titre-album">${esc(titre)}</p>` : ''}
    <div class="grande">${img ? `<img src="${esc(img)}" alt="Couverture du n° ${n}">` : n}</div>
    <div class="choix">${['possede', 'remplacer', 'manquant'].map((x) =>
      `<button class="c-${x}" data-a="etat" data-e="${x}" aria-pressed="${x === e}">${SIGNES[x]} ${LIBELLES[x]}</button>`).join('')}</div>
    <p class="meta">${f.par ? `Modifié par ${esc(f.par)}${quand ? ' le ' + quand : ''}` : ''}</p>
    <details class="perso"><summary>Changer l'image de couverture</summary>
      <label for="i-lien">Lien d'une image</label>
      <input id="i-lien" value="${esc(f.couverture || '')}" placeholder="https://…">
      <div class="rang"><button class="btn" data-a="couvDefaut">Image d'origine</button><button class="btn plein" data-a="couvLien">Enregistrer le lien</button></div>
    </details>
    <div class="rang entre">${lienWiki}<button class="btn" data-a="fermer">Fermer</button></div>`);
}

// --- Réglages du groupe
function rendreReglagesGroupe() {
  ouvrirFenetre(`
    <h2>Réglages</h2>
    <section><h3>Ton prénom</h3><div class="rang"><input id="i-prenom2" value="${esc(S.prenom)}"><button class="btn" data-a="prenom">OK</button></div></section>
    <section><h3>Code du groupe</h3><p class="code">${esc(S.groupe)}</p>
      <div class="rang"><button class="btn" data-a="partager" data-t="code">Partager le code</button>
        <button class="btn" data-a="partager" data-t="installation">Partager le lien d'installation</button></div></section>
    <section><h3>Mes groupes</h3><div class="puces">${S.mesGroupes.map((g) =>
      `<button class="puce${g === S.groupe ? ' actif' : ''}" data-a="groupe" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div>
      <div class="rang"><button class="btn" data-a="changerGroupe">Ouvrir un autre groupe</button></div></section>
    <p class="aide">Vert : je l'ai · orange : je l'ai mais en mauvais état · rouge : je ne l'ai pas.<br>Couvertures : wiki Picsou, Inducks, Bédéthèque et bdovore.</p>
    <div class="rang entre"><span></span><button class="btn" data-a="fermer">Fermer</button></div>`);
}

// --- Réglages d'une collection
let confirmerSuppr = false, confirmerImport = false;
function rendreReglagesCol() {
  const c = colParId(S.col);
  ouvrirFenetre(`
    <h2>${esc(c.nom)}</h2>
    <section><h3>Nombre de numéros parus</h3>
      <div class="rang total"><button class="btn" data-a="total" data-d="-1" aria-label="Un de moins">−</button><output>${c.total}</output><button class="btn" data-a="total" data-d="1" aria-label="Un de plus">+</button></div>
      <p class="aide">Ajoute 1 à chaque nouveau numéro : il apparaît en rouge pour tout le monde.</p></section>
    <section><h3>Importer une liste</h3>
      <p class="aide">Un numéro par ligne, avec « remplacer » s'il est en mauvais état. Tout ce qui n'y figure pas passe en « Je ne l'ai pas ! ».</p>
      <textarea id="i-import" placeholder="237&#10;236&#10;209 à remplacer"></textarea>
      <p class="aide" id="apercu-import"></p>
      <div class="rang"><button class="btn ${confirmerImport ? 'danger' : 'plein'}" data-a="importer">${confirmerImport ? 'Oui, remplacer toute la liste' : 'Importer'}</button></div></section>
    ${c.perso ? `<section><h3>Supprimer</h3><button class="btn ${confirmerSuppr ? 'danger' : ''}" data-a="supprimerCol">${confirmerSuppr ? 'Oui, supprimer définitivement' : 'Supprimer cette collection'}</button></section>` : ''}
    <div class="rang entre"><span></span><button class="btn" data-a="fermer">Fermer</button></div>`);
  $('#i-import').addEventListener('input', () => { confirmerImport = false; majApercuImport(); });
}
function lireListe(texte) {
  const etats = {};
  for (const brute of texte.split(/\r?\n/)) {
    const l = brute.replace('💯', '100').trim(); const m = l.match(/^(\d+)/);
    if (!m || !+m[1]) continue;
    const n = +m[1]; if (etats[n] !== 'remplacer') etats[n] = /rempla/i.test(l) ? 'remplacer' : 'possede';
  }
  return etats;
}
function majApercuImport() {
  const e = lireListe($('#i-import').value), nb = Object.keys(e).length, r = Object.values(e).filter((x) => x === 'remplacer').length;
  $('#apercu-import').textContent = nb ? `${nb} numéros reconnus, dont ${r} en mauvais état.` : '';
}

// --- Nouvelle collection
function rendreNouvelleCol() {
  ouvrirFenetre(`
    <h2>Nouvelle collection</h2>
    <form id="f-col" class="formulaire">
      <label for="i-nom">Nom de la collection</label><input id="i-nom" required maxlength="60" placeholder="ex. Mickey Parade">
      <label for="i-total">Nombre de numéros</label><input id="i-total" type="number" min="1" max="2000" required value="50">
      <p class="aide">Elle sera visible par tout le groupe. Tu pourras ajouter une image de couverture à chaque numéro depuis sa fiche.</p>
      <div class="rang entre"><button class="btn" type="button" data-a="fermer">Annuler</button><button class="btn plein" type="submit">Créer</button></div>
    </form>`);
  $('#f-col').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nom = $('#i-nom').value.trim(), total = parseInt($('#i-total').value, 10);
    if (!nom || !(total > 0)) return;
    try { const id = await S.base.creerCollection(S.groupe, nom, total); dlg.close(); toast(`Collection « ${nom} » créée.`); S.col = id; S.ecran = 'collection'; S.filtre = 'tous'; S.recherche = ''; rendre(); }
    catch (e) { toast('Création impossible. Vérifie ta connexion et réessaie.'); }
  });
}

// ------------------------------------------------------------------ Actions
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a, c = S.col && colParId(S.col);
  const echec = () => toast("Enregistrement impossible. Vérifie ta connexion et réessaie.");
  switch (a) {
    case 'groupe': {
      const g = el.dataset.g; if (dlg.open) dlg.close();
      if (!S.prenom) { attenteCreation = null; S.ecran = 'accueil'; rendre(); $('#i-code').value = g; return; }
      ouvrirGroupe(g); break;
    }
    case 'creerGroupe': try { await S.base.creerGroupe(attenteCreation); const g = attenteCreation; attenteCreation = null; ouvrirGroupe(g); } catch (e) { echec(); } break;
    case 'corriger': attenteCreation = null; rendre(); $('#i-code').focus(); break;
    case 'changerGroupe': dlg.close(); quitterGroupe(); break;
    case 'ouvrirCol': S.col = el.dataset.id; S.ecran = 'collection'; S.filtre = 'tous'; S.recherche = ''; scrollTo(0, 0); rendre(); break;
    case 'accueil': if (dlg.open) dlg.close(); arreterEcoutes(); S.col = null; document.body.dataset.col = ''; S.ecran = 'accueil'; rendre(); scrollTo(0, 0); break;
    case 'retour': S.ecran = 'collections'; S.col = null; document.body.dataset.col = ''; rendre(); scrollTo(0, 0); break;
    case 'nouvelleCol': rendreNouvelleCol(); break;
    case 'reglagesGroupe': rendreReglagesGroupe(); break;
    case 'reglagesCol': confirmerSuppr = false; confirmerImport = false; rendreReglagesCol(); break;
    case 'vue': S.vue = S.vue === 'grille' ? 'liste' : 'grille'; ecrire('mcb-vue', S.vue); rendre(); break;
    case 'ordre': S.decroissant = !S.decroissant; ecrire('mcb-ordre', S.decroissant); rendre(); break;
    case 'filtre': S.filtre = S.filtre === el.dataset.f ? 'tous' : el.dataset.f; rendre(); break;
    case 'fiche': ficheOuverte = +el.dataset.n; rendreFiche(); break;
    case 'fermer': dlg.close(); break;
    case 'etat': S.base.changerEtat(S.groupe, c.id, ficheOuverte, el.dataset.e, S.prenom).catch(echec); break;
    case 'couvLien': S.base.definirCouverture(S.groupe, c.id, ficheOuverte, $('#i-lien').value.trim()).then(() => toast('Image enregistrée.')).catch(echec); break;
    case 'couvDefaut': S.base.definirCouverture(S.groupe, c.id, ficheOuverte, null).then(() => toast("Image d'origine rétablie.")).catch(echec); break;
    case 'prenom': { const p = $('#i-prenom2').value.trim(); if (p) { S.prenom = p; ecrire('mcb-prenom', p); toast('Prénom enregistré.'); } break; }
    case 'partager': {
      const texte = el.dataset.t === 'code'
        ? `Rejoins mes collections dans l'application Mes Collections BD avec le code : ${S.groupe}\nVersion web : ${SITE}`
        : `Installe l'application Mes Collections BD : ${LIEN_APK}\n(ou la version web : ${SITE})\nPuis rejoins mes collections avec le code : ${S.groupe}`;
      if (navigator.share && matchMedia('(pointer: coarse)').matches) { try { await navigator.share({ text: texte }); } catch (e) {} break; }
      try { await navigator.clipboard.writeText(texte); toast('Message copié : colle-le où tu veux.'); } catch (e) { toast(texte); }
      break;
    }
    case 'total': { const t = c.total + +el.dataset.d; if (t >= 1) { await S.base.definirTotal(S.groupe, c.id, t).catch(echec); rendreReglagesCol(); } break; }
    case 'importer': {
      const etats = lireListe($('#i-import').value); if (!Object.keys(etats).length) return;
      if (!confirmerImport) { confirmerImport = true; const t = $('#i-import').value; rendreReglagesCol(); $('#i-import').value = t; majApercuImport(); return; }
      const max = Math.max(c.total, ...Object.keys(etats).map(Number));
      if (max > c.total) await S.base.definirTotal(S.groupe, c.id, max);
      const liste = [];
      for (let n = 1; n <= max; n++) { const e = etats[n] || 'manquant'; if (e === 'manquant' && !S.numeros[c.id]?.[n]) continue; if (etatDe(c.id, n) !== e) liste.push([n, e]); }
      try { await S.base.ecrireEtats(S.groupe, c.id, liste, S.prenom); confirmerImport = false; dlg.close(); toast('Liste importée.'); } catch (e) { echec(); }
      break;
    }
    case 'supprimerCol':
      if (!confirmerSuppr) { confirmerSuppr = true; rendreReglagesCol(); return; }
      try { await S.base.supprimerCollection(S.groupe, c.id); dlg.close(); S.ecran = 'collections'; S.col = null; rendre(); toast('Collection supprimée.'); } catch (e) { echec(); }
      break;
  }
});

let minuteur;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(minuteur); minuteur = setTimeout(() => { t.hidden = true; }, 3800); }

// ------------------------------------------------------------------ Démarrage
(async () => {
  rendre();
  try { S.base = await ouvrirBase(window.FIREBASE_CONFIG); }
  catch (e) { app.innerHTML = '<p class="vide">Connexion au serveur impossible. Vérifie ta connexion Internet puis recharge la page.</p>'; return; }
  if (S.groupe && S.prenom && (S.base.demo ? await S.base.groupeExiste(S.groupe) : true)) ouvrirGroupe(S.groupe);
  else { S.ecran = 'accueil'; rendre(); }
  if ('serviceWorker' in navigator && !S.base.demo) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
