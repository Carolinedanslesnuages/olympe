/**
 * Olympe's rules. Each finding: { level, rule, message, line? }.
 *
 *   error     the official Agent Skills format is not followed (https://agentskills.io/specification)
 *   security  the skill can do more than give instructions: review it before installing
 *   quality   recommendation from the specification, or good practice
 */
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, normalize, sep, dirname, basename } from 'node:path';

const withoutAccents = (text) => String(text).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
/** Phrases that say WHEN to use a skill (compared without accents or case). */
const WHEN_PATTERN = /(^|[^a-z])(quand|lorsque|lorsqu|des que|a utiliser|a declencher|pour chaque|chaque fois|use (it )?when|use for|when (the|you|a|an)|whenever|trigger)([^a-z]|$)/;

const SPEC_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
/** Fields specific to some agents (mostly Claude Code): accepted, but reported. */
const KNOWN_FIELDS = ['disable-model-invocation', 'user-invocable', 'argument-hint', 'model', 'context', 'agent', 'hooks', 'version', 'when_to_use', 'paths', 'shell', 'effort'];

const lineAt = (skill, index) => skill.lineOffset + skill.body.slice(0, index).split('\n').length;
const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

function checkName(header, skill, report) {
  const { name } = header;
  if (isBlank(name)) return report('name', '« name » est obligatoire');
  if (typeof name !== 'string') return report('name', '« name » doit être un texte');
  if (name.length > 64) report('name', `« name » fait ${name.length} caractères (64 au plus)`);
  if (!/^[a-z0-9-]+$/.test(name)) report('name', `« ${name} » : seulement des minuscules sans accent, des chiffres et des tirets`);
  if (/^-|-$/.test(name)) report('name', `« ${name} » ne doit pas commencer ni finir par un tiret`);
  if (name.includes('--')) report('name', `« ${name} » ne doit pas contenir deux tirets de suite`);
  if (name !== skill.folderName) report('name', `« name » vaut « ${name} » mais le dossier s'appelle « ${skill.folderName} » : ils doivent être identiques`);
  return undefined;
}

/** The official format rules. */
export function formatRules(skill) {
  const findings = [];
  const report = (rule, message) => findings.push({ level: 'error', rule, message });
  if (skill.missingHeader) return [{ level: 'error', rule: 'entete', message: 'pas d\'en-tête YAML : le fichier doit commencer par « --- », les champs, puis « --- »' }];
  if (skill.yamlError) return [{ level: 'error', rule: 'entete', message: `en-tête YAML illisible : ${skill.yamlError}` }];
  const header = skill.header;
  if (typeof header !== 'object' || Array.isArray(header)) return [{ level: 'error', rule: 'entete', message: "l'en-tête YAML doit être une liste de champs « clé: valeur »" }];

  checkName(header, skill, report);
  const { description, compatibility, metadata } = header;
  if (isBlank(description)) report('description', '« description » est obligatoire et ne doit pas être vide');
  else if (typeof description !== 'string') report('description', '« description » doit être un texte');
  else if (description.length > 1024) report('description', `« description » fait ${description.length} caractères (1 024 au plus)`);
  if (compatibility !== undefined) {
    if (typeof compatibility !== 'string' || !compatibility.trim()) report('compatibility', '« compatibility » doit être un texte non vide');
    else if (compatibility.length > 500) report('compatibility', `« compatibility » fait ${compatibility.length} caractères (500 au plus)`);
  }
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) report('metadata', '« metadata » doit être une liste de paires clé: valeur');
    else {
      for (const [metadataKey, value] of Object.entries(metadata)) {
        if (typeof value !== 'string') report('metadata', `« metadata.${metadataKey} » doit être un texte (entre guillemets si c'est un nombre : "1.0")`);
      }
    }
  }
  if (header.license !== undefined && typeof header.license !== 'string') report('license', '« license » doit être un texte');
  if (header['allowed-tools'] !== undefined && typeof header['allowed-tools'] !== 'string') report('allowed-tools', '« allowed-tools » doit être un texte, outils séparés par des espaces');

  for (const field of Object.keys(header)) {
    if (SPEC_FIELDS.includes(field)) continue;
    const message = KNOWN_FIELDS.includes(field)
      ? `« ${field} » n'est pas dans la spécification : compris par certains agents seulement (Claude Code)`
      : `champ inconnu « ${field} » : ignoré par les agents qui suivent la spécification`;
    findings.push({ level: 'quality', rule: 'champ', message });
  }
  return findings;
}

const INJECTION_PATTERN = /(ignore[sz]?\s+(all\s+|toutes?\s+)?(les\s+|tes\s+|vos\s+|your\s+|previous\s+|prior\s+|the\s+)*(instructions|consignes|règles|rules))|(oublie[sz]?\s+(tes|vos|les)\s+(instructions|consignes))/i;

/** A prompt-injection phrase, unless it is quoted or presented as something NOT to follow. */
export function isInjection(line) {
  const match = INJECTION_PATTERN.exec(line);
  if (!match) return false;
  const before = line.slice(0, match.index);
  const openQuotes = (before.match(/[«“"]/g) || []).length - (before.match(/[»”]/g) || []).length;
  const straightQuotes = (before.match(/"/g) || []).length;
  if (openQuotes > 0 && (straightQuotes % 2 === 1 || /[«“]/.test(before))) return false;
  if (/(do not|don't|never|ne (le |la |les )?(suivez|suis|suivre) (pas|jamais)|ne pas (le |la |les )?suivre|sans (le |la |les )?suivre|refuse[rz]?)/i.test(line)) return false;
  return true;
}

/** What gives the skill more power than a plain text of instructions. */
export function securityRules(skill) {
  const findings = [];
  const report = (rule, message, line) => findings.push({ level: 'security', rule, message, ...(line ? { line } : {}) });
  const header = skill.header || {};
  if (typeof header['allowed-tools'] === 'string') {
    const tools = header['allowed-tools'].split(/\s+/).filter(Boolean);
    const unrestricted = tools.filter((tool) => /^Bash(\(\*?\))?$|^Bash\(\*\)$|\(\*\)$/.test(tool) || tool === '*');
    report('allowed-tools', `pré-autorise des outils sans demander : ${tools.join(', ')}${unrestricted.length ? ` (dont ${unrestricted.join(', ')} : sans aucune limite)` : ''}`);
  }
  if (header.hooks !== undefined) report('hooks', 'déclare des hooks : des commandes lancées automatiquement pendant la session');
  // Claude Code runs "!`command`" when the skill loads, before the model even reads the text.
  for (const match of skill.text.matchAll(/!`([^`\n]+)`/g)) {
    report('commande-au-chargement', `commande exécutée au chargement : ${match[1].slice(0, 80)}`, skill.text.slice(0, match.index).split('\n').length);
  }
  skill.body.split('\n').forEach((line, index) => {
    const lineNumber = skill.lineOffset + index + 1;
    const excerpt = line.trim().slice(0, 80);
    if (/\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/i.test(line)) report('telechargement-execute', 'télécharge et exécute un script (« curl … | sh »)', lineNumber);
    if (isInjection(line)) report('consigne-piegee', `demande d'ignorer les consignes : « ${excerpt} »`, lineNumber);
    if (/\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/.test(line)) {
      report('secret', 'ressemble à un secret (clé ou jeton) écrit en clair', lineNumber);
    }
    if (/(^|[^\w-])(rm\s+-(rf|fr)\s+(~|\/|\$HOME)(\/?\*?)(\s|$)|git\s+push\s+(-f|--force)(\s|$)|chmod\s+(-R\s+)?777(\s|$))/.test(line)) {
      report('commande-destructrice', `commande risquée : « ${excerpt} »`, lineNumber);
    }
  });
  return findings;
}

/** Sibling skills that hold a file the skill links to (an intended but fragile cross-reference). */
function siblingsWithFile(skill, target) {
  const parent = dirname(skill.folder);
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== basename(skill.folder) && existsSync(join(parent, entry.name, target)))
      .map((entry) => entry.name);
  } catch {
    return []; // parent folder not readable
  }
}

/** Links to files of the skill: they must exist and stay inside the skill. */
function referenceFindings(skill, report) {
  const references = new Map();
  for (const match of skill.body.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)|`((?:references|scripts|assets)\/[^`\s]+)`/g)) {
    const target = match[1] || match[2];
    if (/^[a-z]+:/i.test(target) || target.startsWith('/')) continue; // URL, absolute path
    if (!references.has(target)) references.set(target, lineAt(skill, match.index));
  }
  const errors = [];
  for (const [target, line] of references) {
    const path = normalize(join(skill.folder, target));
    if (!path.startsWith(skill.folder + sep) && path !== skill.folder) report('reference', `« ${target} » pointe hors du dossier de la skill`, line);
    else if (!existsSync(path)) {
      const siblings = siblingsWithFile(skill, target);
      if (siblings.length) {
        report('reference', `« ${target} » n'est pas dans cette skill mais dans la skill voisine « ${siblings[0]} » : si les skills sont installées séparément, l'agent ne le trouvera pas`, line);
      } else errors.push({ level: 'error', rule: 'reference', message: `lien cassé : « ${target} » n'existe pas`, line });
    } else if (statSync(path).isFile() && target.split('/').length > 2) {
      report('reference', `« ${target} » est à plus d'un niveau de SKILL.md (la spécification recommande un seul niveau)`, line);
    }
  }
  return errors;
}

/** Recommendations from the specification, and good practice. */
export function qualityRules(skill, { maxLines = 500 } = {}) {
  const findings = [];
  const report = (rule, message, line) => findings.push({ level: 'quality', rule, message, ...(line ? { line } : {}) });
  const header = skill.header || {};
  if (typeof header.description === 'string') {
    if (header.description.length < 40) report('description', `description très courte (${header.description.length} caractères) : dites ce que fait la skill et quand l'utiliser`);
    const hasWhenToUse = typeof header.when_to_use === 'string' && header.when_to_use.trim();
    if (!WHEN_PATTERN.test(withoutAccents(header.description)) && !hasWhenToUse) {
      report('description', "la description ne dit pas QUAND utiliser la skill (« À utiliser quand… ») : l'agent risque de ne pas la déclencher");
    }
  }
  const lineCount = skill.text.split('\n').length;
  if (lineCount > maxLines) report('taille', `${lineCount} lignes (plus de ${maxLines}) : déplacez le détail dans references/`);
  const tokens = Math.round(skill.body.length / 4);
  if (tokens > 5000) report('taille', `environ ${tokens} tokens dans le corps (moins de 5 000 recommandés)`);
  findings.push(...referenceFindings(skill, report));
  return findings;
}

export function checkSkill(skill, options) {
  const format = formatRules(skill);
  const headerBroken = format.some((finding) => finding.rule === 'entete');
  return [...format, ...securityRules(skill), ...(headerBroken ? [] : qualityRules(skill, options))];
}
