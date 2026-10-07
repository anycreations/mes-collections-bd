// Accès aux données : Firebase (même base que l'application Android) ou mode démonstration.
//
// Organisation de la base (partagée avec l'application Android) :
//   groupes/{CODE}                                   { total }  ← total de la collection SPG
//   groupes/{CODE}/numeros/{N}                       numéros de la collection SPG
//   groupes/{CODE}/collections/{ID}                  { nom, total, perso, creeLe }
//   groupes/{CODE}/collections/{ID}/numeros/{N}      numéros des autres collections
//   chaque numéro : { etat: "possede"|"remplacer"|"manquant", par, le, couverture? }

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';

export async function ouvrirBase(config) {
  if (!config || !config.apiKey) return baseDemo();
  const [{ initializeApp }, fs, au] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-firestore.js'),
    import(SDK + 'firebase-auth.js'),
  ]);
  const app = initializeApp(config);
  const db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
  const auth = au.getAuth(app);
  if (!auth.currentUser) await au.signInAnonymously(auth);
  return baseFirebase(db, fs);
}

function baseFirebase(db, f) {
  const groupe = (code) => f.doc(db, 'groupes', code);
  const colNumeros = (code, col) =>
    col === 'spg' ? f.collection(db, 'groupes', code, 'numeros')
                  : f.collection(db, 'groupes', code, 'collections', col, 'numeros');
  const docCollection = (code, col) => f.doc(db, 'groupes', code, 'collections', col);

  return {
    demo: false,

    /** Un groupe existe s'il a sa fiche ou au moins un numéro ou une collection. */
    async groupeExiste(code) {
      const g = await f.getDoc(groupe(code));
      if (g.exists()) return true;
      const n = await f.getDocs(f.query(f.collection(db, 'groupes', code, 'numeros'), f.limit(1)));
      if (!n.empty) return true;
      const c = await f.getDocs(f.query(f.collection(db, 'groupes', code, 'collections'), f.limit(1)));
      return !c.empty;
    },

    async creerGroupe(code) {
      await f.setDoc(groupe(code), { total: 255, creeLe: f.serverTimestamp() }, { merge: true });
    },

    /** Réglages des collections du groupe : { spgTotal, docs: { id: data } }. */
    ecouterCollections(code, rappel, erreur) {
      let spgTotal = null, docs = {};
      const u1 = f.onSnapshot(groupe(code), (s) => {
        spgTotal = s.exists() ? s.data().total ?? null : null; rappel({ spgTotal, docs });
      }, erreur);
      const u2 = f.onSnapshot(f.collection(db, 'groupes', code, 'collections'), (s) => {
        docs = {}; s.forEach((d) => { docs[d.id] = d.data(); }); rappel({ spgTotal, docs });
      }, erreur);
      return () => { u1(); u2(); };
    },

    /** Numéros d'une collection : { n: { etat, par, le, couverture } }. */
    ecouterNumeros(code, col, rappel, erreur) {
      return f.onSnapshot(colNumeros(code, col), (s) => {
        const fiches = {};
        s.forEach((d) => {
          const n = parseInt(d.id, 10);
          if (n > 0) { const x = d.data(); fiches[n] = { ...x, le: x.le?.toDate ? x.le.toDate() : null }; }
        });
        rappel(fiches);
      }, erreur);
    },

    async changerEtat(code, col, n, etat, par) {
      await f.setDoc(f.doc(colNumeros(code, col), String(n)),
        { etat, par: par || '?', le: f.serverTimestamp() }, { merge: true });
    },

    async definirCouverture(code, col, n, lien) {
      await f.setDoc(f.doc(colNumeros(code, col), String(n)),
        { couverture: lien ? lien : f.deleteField() }, { merge: true });
    },

    async definirTotal(code, col, total) {
      if (col === 'spg') await f.setDoc(groupe(code), { total }, { merge: true });
      else await f.setDoc(docCollection(code, col), { total }, { merge: true });
    },

    async creerCollection(code, nom, total) {
      const ref = f.doc(f.collection(db, 'groupes', code, 'collections'));
      await f.setDoc(ref, { nom, total, perso: true, creeLe: f.serverTimestamp() });
      return ref.id;
    },

    async supprimerCollection(code, col) {
      const s = await f.getDocs(colNumeros(code, col));
      const docs = s.docs;
      for (let i = 0; i < docs.length; i += 400) {
        const lot = f.writeBatch(db);
        docs.slice(i, i + 400).forEach((d) => lot.delete(d.ref));
        await lot.commit();
      }
      await f.deleteDoc(docCollection(code, col));
    },

    /** Reprend les cases d'une ancienne collection perso dans une collection du catalogue, puis la supprime. */
    async migrerCollection(code, ancien, nouveau, total) {
      const [vieux, neuf] = await Promise.all([f.getDocs(colNumeros(code, ancien)), f.getDocs(colNumeros(code, nouveau))]);
      const deja = new Set(neuf.docs.map((d) => d.id));
      const aCopier = vieux.docs.filter((d) => !deja.has(d.id));
      for (let i = 0; i < aCopier.length; i += 400) {
        const lot = f.writeBatch(db);
        aCopier.slice(i, i + 400).forEach((d) => lot.set(f.doc(colNumeros(code, nouveau), d.id), d.data(), { merge: true }));
        await lot.commit();
      }
      if (total) await f.setDoc(docCollection(code, nouveau), { total }, { merge: true });
      for (let i = 0; i < vieux.docs.length; i += 400) {
        const lot = f.writeBatch(db);
        vieux.docs.slice(i, i + 400).forEach((d) => lot.delete(d.ref));
        await lot.commit();
      }
      await f.deleteDoc(docCollection(code, ancien));
    },

    /** Écrit plusieurs états d'un coup : [[n, etat], …]. */
    async ecrireEtats(code, col, liste, par) {
      for (let i = 0; i < liste.length; i += 400) {
        const lot = f.writeBatch(db);
        liste.slice(i, i + 400).forEach(([n, etat]) =>
          lot.set(f.doc(colNumeros(code, col), String(n)), { etat, par: par || '?', le: f.serverTimestamp() }, { merge: true }));
        await lot.commit();
      }
    },
  };
}

// ------------------------------------------------------------------ Démonstration
// Données d'exemple en mémoire, pour essayer la page sans connexion à la base.
function baseDemo() {
  const groupes = {
    'DEMO-PICSOU': { spgTotal: 255, docs: {}, numeros: { spg: {}, tresors: {}, doubleduck: {}, dynastie: {} } },
  };
  const g0 = groupes['DEMO-PICSOU'].numeros;
  for (let n = 1; n <= 237; n++) if (n % 4) g0.spg[n] = { etat: n % 9 === 0 ? 'remplacer' : 'possede', par: 'Exemple' };
  for (let n = 1; n <= 40; n++) if (n % 3) g0.tresors[n] = { etat: 'possede', par: 'Exemple' };
  g0.doubleduck[1] = { etat: 'possede' }; g0.doubleduck[2] = { etat: 'remplacer' };
  for (let n = 1; n <= 6; n++) g0.dynastie[n] = { etat: 'possede' };
  groupes['DEMO-PICSOU'].docs.persoF = { nom: 'Les chroniques de Fantomiald', total: 30, perso: true };
  g0.persoF = { 1: { etat: 'possede' }, 2: { etat: 'remplacer' } };
  const ecoutes = new Set();
  const notifier = () => ecoutes.forEach((f) => f());
  const g = (code) => groupes[code];

  return {
    demo: true,
    async groupeExiste(code) { return !!g(code); },
    async creerGroupe(code) { groupes[code] = { spgTotal: 255, docs: {}, numeros: { spg: {} } }; },
    ecouterCollections(code, rappel) {
      const f = () => g(code) && rappel({ spgTotal: g(code).spgTotal, docs: { ...g(code).docs } });
      ecoutes.add(f); setTimeout(f, 50); return () => ecoutes.delete(f);
    },
    ecouterNumeros(code, col, rappel) {
      const f = () => g(code) && rappel({ ...(g(code).numeros[col] || {}) });
      ecoutes.add(f); setTimeout(f, 50); return () => ecoutes.delete(f);
    },
    async changerEtat(code, col, n, etat, par) {
      const num = (g(code).numeros[col] ||= {});
      num[n] = { ...num[n], etat, par, le: new Date() }; notifier();
    },
    async definirCouverture(code, col, n, lien) {
      const num = (g(code).numeros[col] ||= {});
      num[n] = { ...num[n], couverture: lien || undefined }; notifier();
    },
    async definirTotal(code, col, total) {
      if (col === 'spg') g(code).spgTotal = total; else g(code).docs[col] = { ...g(code).docs[col], total };
      notifier();
    },
    async creerCollection(code, nom, total) {
      const id = 'perso' + Date.now();
      g(code).docs[id] = { nom, total, perso: true, creeLe: new Date() }; g(code).numeros[id] = {}; notifier();
      return id;
    },
    async migrerCollection(code, ancien, nouveau, total) {
      const G = g(code); G.numeros[nouveau] = { ...(G.numeros[ancien] || {}), ...(G.numeros[nouveau] || {}) };
      if (total) G.docs[nouveau] = { ...G.docs[nouveau], total };
      delete G.docs[ancien]; delete G.numeros[ancien]; notifier();
    },
    async supprimerCollection(code, col) { delete g(code).docs[col]; delete g(code).numeros[col]; notifier(); },
    async ecrireEtats(code, col, liste, par) {
      const num = (g(code).numeros[col] ||= {});
      liste.forEach(([n, etat]) => { num[n] = { ...num[n], etat, par, le: new Date() }; }); notifier();
    },
  };
}
