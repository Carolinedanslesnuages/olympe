#!/usr/bin/env node
/** Olympe : vérificateur de skills (format Agent Skills, sécurité, qualité). */
import { relative } from 'node:path';
import { trouverSkills, lireSkill } from '../src/lecture.mjs';
import { verifierSkill } from '../src/regles.mjs';

const AIDE = `Olympe · vérificateur de skills (format Agent Skills)

Usage : olympe [chemins…] [options]

  chemins            dossiers à parcourir, ou fichiers SKILL.md (défaut : dossier courant)
  --strict           échoue aussi sur les points de sécurité (pas seulement sur les erreurs)
  --max-lignes <n>   taille maximum conseillée d'un SKILL.md (défaut : 500)
  --json             résultat en JSON
  --aide             cette aide

Trois niveaux :
  ✗ erreur    le format officiel n'est pas respecté (https://agentskills.io/specification)
  ⚠ sécurité  la skill peut faire plus que donner des consignes : à relire avant de l'installer
  · qualité   recommandation, sans effet sur le résultat

Code de sortie : 1 s'il y a une erreur (ou un point de sécurité avec --strict), 0 sinon.`;

function options(args) {
  const o = { chemins: [], maxLignes: 500 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--aide' || a === '-h' || a === '--help') o.aide = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--json') o.json = true;
    else if (a === '--max-lignes') {
      o.maxLignes = Number(args[++i]);
      if (!Number.isInteger(o.maxLignes) || o.maxLignes < 1) throw new Error('--max-lignes attend un nombre entier positif.');
    } else if (a.startsWith('--')) throw new Error(`Option inconnue : ${a}. Tapez « olympe --aide ».`);
    else o.chemins.push(a);
  }
  if (!o.chemins.length) o.chemins.push('.');
  return o;
}

const SYMBOLE = { erreur: '✗', securite: '⚠', qualite: '·' };
const NIVEAU_GITHUB = { erreur: 'error', securite: 'warning', qualite: 'notice' };

async function principal() {
  const o = options(process.argv.slice(2));
  if (o.aide) return console.log(AIDE);
  const dossiers = await trouverSkills(o.chemins);
  if (!dossiers.length) throw new Error(`Aucun SKILL.md trouvé dans : ${o.chemins.join(', ')}`);
  const resultats = [];
  for (const d of dossiers) {
    const skill = await lireSkill(d);
    resultats.push({ skill: relative(process.cwd(), d) || '.', nom: skill.entete && skill.entete.name, constats: verifierSkill(skill, { maxLignes: o.maxLignes }) });
  }
  const compte = (niveau) => resultats.reduce((n, r) => n + r.constats.filter((c) => c.niveau === niveau).length, 0);
  const total = { erreurs: compte('erreur'), securite: compte('securite'), qualite: compte('qualite') };
  const echec = total.erreurs > 0 || (o.strict && total.securite > 0);

  if (o.json) console.log(JSON.stringify({ skills: resultats, total, echec }, null, 2));
  else {
    for (const r of resultats) {
      const pire = r.constats.some((c) => c.niveau === 'erreur') ? '✗' : r.constats.some((c) => c.niveau === 'securite') ? '⚠' : '✓';
      console.log(`${pire} ${r.skill}`);
      for (const c of r.constats) {
        console.log(`    ${SYMBOLE[c.niveau]} ${c.message}${c.ligne ? ` (ligne ${c.ligne})` : ''}`);
        if (process.env.GITHUB_ACTIONS) console.log(`::${NIVEAU_GITHUB[c.niveau]} file=${r.skill}/SKILL.md${c.ligne ? `,line=${c.ligne}` : ''},title=Olympe (${c.regle})::${c.message}`);
      }
    }
    console.log(`\n${resultats.length} skill${resultats.length > 1 ? 's' : ''} · ${total.erreurs} erreur${total.erreurs > 1 ? 's' : ''} · ${total.securite} point${total.securite > 1 ? 's' : ''} de sécurité · ${total.qualite} remarque${total.qualite > 1 ? 's' : ''} de qualité`);
  }
  if (echec) process.exitCode = 1;
}

principal().catch((e) => {
  console.error(`olympe : ${e.message}`);
  process.exit(1);
});
