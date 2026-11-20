/**
 * Les règles d'Olympe. Chaque constat : { niveau, regle, message, ligne? }.
 *
 *   erreur    le format officiel Agent Skills n'est pas respecté (https://agentskills.io/specification)
 *   securite  la skill peut faire plus que donner des consignes : à relire avant de l'installer
 *   qualite   recommandation de la spécification ou bonne pratique
 */
import { existsSync, statSync } from 'node:fs';
import { join, normalize, sep, dirname, basename } from 'node:path';
import { readdirSync } from 'node:fs';

const sansAccent = (t) => String(t).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
/** Formules qui disent QUAND utiliser une skill (comparées sans accents ni majuscules). */
const QUAND = /(^|[^a-z])(quand|lorsque|lorsqu|des que|a utiliser|a declencher|pour chaque|chaque fois|use (it )?when|use for|when (the|you|a|an)|whenever|trigger)([^a-z]|$)/;

const CHAMPS_SPEC = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
/** Champs propres à certains agents (Claude Code surtout) : admis, mais signalés. */
const CHAMPS_CONNUS = ['disable-model-invocation', 'user-invocable', 'argument-hint', 'model', 'context', 'agent', 'hooks', 'version', 'when_to_use', 'paths', 'shell', 'effort'];

const ligneDe = (skill, index) => skill.decalage + skill.corps.slice(0, index).split('\n').length;

/** Les règles du format officiel. */
export function reglesFormat(skill) {
  const c = [];
  const e = (regle, message) => c.push({ niveau: 'erreur', regle, message });
  if (skill.sansEntete) return [{ niveau: 'erreur', regle: 'entete', message: 'pas d\'en-tête YAML : le fichier doit commencer par « --- », les champs, puis « --- »' }];
  if (skill.erreurYaml) return [{ niveau: 'erreur', regle: 'entete', message: `en-tête YAML illisible : ${skill.erreurYaml}` }];
  const h = skill.entete;
  if (typeof h !== 'object' || Array.isArray(h)) return [{ niveau: 'erreur', regle: 'entete', message: "l'en-tête YAML doit être une liste de champs « clé: valeur »" }];

  // name
  if (h.name === undefined || h.name === null || h.name === '') e('name', '« name » est obligatoire');
  else if (typeof h.name !== 'string') e('name', '« name » doit être un texte');
  else {
    if (h.name.length > 64) e('name', `« name » fait ${h.name.length} caractères (64 au plus)`);
    if (!/^[a-z0-9-]+$/.test(h.name)) e('name', `« ${h.name} » : seulement des minuscules sans accent, des chiffres et des tirets`);
    if (/^-|-$/.test(h.name)) e('name', `« ${h.name} » ne doit pas commencer ni finir par un tiret`);
    if (h.name.includes('--')) e('name', `« ${h.name} » ne doit pas contenir deux tirets de suite`);
    if (h.name !== skill.nomDossier) e('name', `« name » vaut « ${h.name} » mais le dossier s'appelle « ${skill.nomDossier} » : ils doivent être identiques`);
  }
  // description
  if (h.description === undefined || h.description === null || String(h.description).trim() === '') e('description', '« description » est obligatoire et ne doit pas être vide');
  else if (typeof h.description !== 'string') e('description', '« description » doit être un texte');
  else if (h.description.length > 1024) e('description', `« description » fait ${h.description.length} caractères (1 024 au plus)`);
  // compatibility
  if (h.compatibility !== undefined) {
    if (typeof h.compatibility !== 'string' || !h.compatibility.trim()) e('compatibility', '« compatibility » doit être un texte non vide');
    else if (h.compatibility.length > 500) e('compatibility', `« compatibility » fait ${h.compatibility.length} caractères (500 au plus)`);
  }
  // metadata
  if (h.metadata !== undefined) {
    if (typeof h.metadata !== 'object' || h.metadata === null || Array.isArray(h.metadata)) e('metadata', '« metadata » doit être une liste de paires clé: valeur');
    else for (const [k, v] of Object.entries(h.metadata)) if (typeof v !== 'string') e('metadata', `« metadata.${k} » doit être un texte (entre guillemets si c'est un nombre : "1.0")`);
  }
  if (h.license !== undefined && typeof h.license !== 'string') e('license', '« license » doit être un texte');
  if (h['allowed-tools'] !== undefined && typeof h['allowed-tools'] !== 'string') e('allowed-tools', '« allowed-tools » doit être un texte, outils séparés par des espaces');

  for (const cle of Object.keys(h)) {
    if (CHAMPS_SPEC.includes(cle)) continue;
    c.push({ niveau: 'qualite', regle: 'champ', message: CHAMPS_CONNUS.includes(cle) ? `« ${cle} » n'est pas dans la spécification : compris par certains agents seulement (Claude Code)` : `champ inconnu « ${cle} » : ignoré par les agents qui suivent la spécification` });
  }
  return c;
}

const PIEGE = /(ignore[sz]?\s+(all\s+|toutes?\s+)?(les\s+|tes\s+|vos\s+|your\s+|previous\s+|prior\s+|the\s+)*(instructions|consignes|règles|rules))|(oublie[sz]?\s+(tes|vos|les)\s+(instructions|consignes))/i;
/** Une formule de piège, sauf si elle est citée (entre guillemets) ou présentée comme à ne PAS suivre. */
export function consignePiegee(ligne) {
  const m = PIEGE.exec(ligne);
  if (!m) return false;
  const avant = ligne.slice(0, m.index);
  const ouverts = (avant.match(/[«“"]/g) || []).length - (avant.match(/[»”]/g) || []).length;
  const guillemetsDroits = (avant.match(/"/g) || []).length;
  if (ouverts > 0 && (guillemetsDroits % 2 === 1 || /[«“]/.test(avant))) return false;
  if (/(do not|don't|never|ne (le |la |les )?(suivez|suis|suivre) (pas|jamais)|ne pas (le |la |les )?suivre|sans (le |la |les )?suivre|refuse[rz]?)/i.test(ligne)) return false;
  return true;
}

/** Ce qui donne à la skill plus de pouvoir qu'un simple texte de consignes. */
export function reglesSecurite(skill) {
  const c = [];
  const s = (regle, message, ligne) => c.push({ niveau: 'securite', regle, message, ...(ligne ? { ligne } : {}) });
  const h = skill.entete || {};
  if (typeof h['allowed-tools'] === 'string') {
    const outils = h['allowed-tools'].split(/\s+/).filter(Boolean);
    const larges = outils.filter((o) => /^Bash(\(\*?\))?$|^Bash\(\*\)$|\(\*\)$/.test(o) || o === '*');
    s('allowed-tools', `pré-autorise des outils sans demander : ${outils.join(', ')}${larges.length ? ` (dont ${larges.join(', ')} : sans aucune limite)` : ''}`);
  }
  if (h.hooks !== undefined) s('hooks', 'déclare des hooks : des commandes lancées automatiquement pendant la session');
  // Claude Code exécute « !`commande` » au chargement de la skill, avant même que le modèle lise le texte.
  for (const m of skill.texte.matchAll(/!`([^`\n]+)`/g)) s('commande-au-chargement', `commande exécutée au chargement : ${m[1].slice(0, 80)}`, skill.texte.slice(0, m.index).split('\n').length);
  const lignes = skill.corps.split('\n');
  lignes.forEach((l, i) => {
    const n = skill.decalage + i + 1;
    if (/\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/i.test(l)) s('telechargement-execute', 'télécharge et exécute un script (« curl … | sh »)', n);
    if (consignePiegee(l))
      s('consigne-piegee', `demande d'ignorer les consignes : « ${l.trim().slice(0, 80)} »`, n);
    if (/\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/.test(l)) s('secret', 'ressemble à un secret (clé ou jeton) écrit en clair', n);
    if (/(^|[^\w-])(rm\s+-(rf|fr)\s+(~|\/|\$HOME)(\/?\*?)(\s|$)|git\s+push\s+(-f|--force)(\s|$)|chmod\s+(-R\s+)?777(\s|$))/.test(l)) s('commande-destructrice', `commande risquée : « ${l.trim().slice(0, 80)} »`, n);
  });
  return c;
}

/** Recommandations de la spécification et bonnes pratiques. */
export function reglesQualite(skill, { maxLignes = 500 } = {}) {
  const c = [];
  const q = (regle, message, ligne) => c.push({ niveau: 'qualite', regle, message, ...(ligne ? { ligne } : {}) });
  const h = skill.entete || {};
  if (typeof h.description === 'string') {
    if (h.description.length < 40) q('description', `description très courte (${h.description.length} caractères) : dites ce que fait la skill et quand l'utiliser`);
    if (!QUAND.test(sansAccent(h.description)) && !(typeof h.when_to_use === 'string' && h.when_to_use.trim()))
      q('description', "la description ne dit pas QUAND utiliser la skill (« À utiliser quand… ») : l'agent risque de ne pas la déclencher");
  }
  const nbLignes = skill.texte.split('\n').length;
  if (nbLignes > maxLignes) q('taille', `${nbLignes} lignes (plus de ${maxLignes}) : déplacez le détail dans references/`);
  const tokens = Math.round(skill.corps.length / 4);
  if (tokens > 5000) q('taille', `environ ${tokens} tokens dans le corps (moins de 5 000 recommandés)`);

  // Liens vers des fichiers de la skill : ils doivent exister et rester dans la skill.
  const refs = new Map();
  for (const m of skill.corps.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)|`((?:references|scripts|assets)\/[^`\s]+)`/g)) {
    const cible = m[1] || m[2];
    if (/^[a-z]+:/i.test(cible) || cible.startsWith('/')) continue; // URL, chemin absolu
    if (!refs.has(cible)) refs.set(cible, ligneDe(skill, m.index));
  }
  for (const [cible, ligne] of refs) {
    const chemin = normalize(join(skill.dossier, cible));
    if (!chemin.startsWith(skill.dossier + sep) && chemin !== skill.dossier) q('reference', `« ${cible} » pointe hors du dossier de la skill`, ligne);
    else if (!existsSync(chemin)) {
      // Le fichier existe-t-il dans une skill voisine ? Renvoi volontaire mais fragile.
      const parent = dirname(skill.dossier);
      let voisines = [];
      try {
        voisines = readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== basename(skill.dossier) && existsSync(join(parent, d.name, cible))).map((d) => d.name);
      } catch {
        /* pas de dossier parent lisible */
      }
      if (voisines.length) q('reference', `« ${cible} » n'est pas dans cette skill mais dans la skill voisine « ${voisines[0]} » : si les skills sont installées séparément, l'agent ne le trouvera pas`, ligne);
      else c.push({ niveau: 'erreur', regle: 'reference', message: `lien cassé : « ${cible} » n'existe pas`, ligne });
    }
    else if (statSync(chemin).isFile() && cible.split('/').length > 2) q('reference', `« ${cible} » est à plus d'un niveau de SKILL.md (la spécification recommande un seul niveau)`, ligne);
  }
  return c;
}

export function verifierSkill(skill, options) {
  const format = reglesFormat(skill);
  const bloque = format.some((x) => x.regle === 'entete');
  return [...format, ...reglesSecurite(skill), ...(bloque ? [] : reglesQualite(skill, options))];
}
