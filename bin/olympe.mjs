#!/usr/bin/env node
/** Olympe: skill checker (Agent Skills format, security, quality). */
import { relative } from 'node:path';
import { findSkills, readSkill } from '../src/skill-files.mjs';
import { checkSkill } from '../src/rules.mjs';

const HELP = `Olympe · vérificateur de skills (format Agent Skills)

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

const SYMBOLS = { error: '✗', security: '⚠', quality: '·' };
const GITHUB_LEVELS = { error: 'error', security: 'warning', quality: 'notice' };
/** Level names in the --json output (public format, kept in French). */
const JSON_LEVELS = { error: 'erreur', security: 'securite', quality: 'qualite' };

function parseOptions(args) {
  const options = { paths: [], maxLines: 500 };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--aide' || argument === '-h' || argument === '--help') options.help = true;
    else if (argument === '--strict') options.strict = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--max-lignes') {
      options.maxLines = Number(args[++index]);
      if (!Number.isInteger(options.maxLines) || options.maxLines < 1) throw new Error('--max-lignes attend un nombre entier positif.');
    } else if (argument.startsWith('--')) throw new Error(`Option inconnue : ${argument}. Tapez « olympe --aide ».`);
    else options.paths.push(argument);
  }
  if (!options.paths.length) options.paths.push('.');
  return options;
}

const plural = (count, word, pluralWord = `${word}s`) => `${count} ${count > 1 ? pluralWord : word}`;

function printText(reports, totals) {
  for (const report of reports) {
    const levels = report.findings.map((finding) => finding.level);
    const worst = levels.includes('error') ? '✗' : levels.includes('security') ? '⚠' : '✓';
    console.log(`${worst} ${report.skillPath}`);
    for (const finding of report.findings) {
      const lineNote = finding.line ? ` (ligne ${finding.line})` : '';
      console.log(`    ${SYMBOLS[finding.level]} ${finding.message}${lineNote}`);
      if (process.env.GITHUB_ACTIONS) {
        const location = `file=${report.skillPath}/SKILL.md${finding.line ? `,line=${finding.line}` : ''}`;
        console.log(`::${GITHUB_LEVELS[finding.level]} ${location},title=Olympe (${finding.rule})::${finding.message}`);
      }
    }
  }
  console.log(`\n${plural(reports.length, 'skill')} · ${plural(totals.errors, 'erreur')} · ${totals.security} point${totals.security > 1 ? 's' : ''} de sécurité · ${totals.quality} remarque${totals.quality > 1 ? 's' : ''} de qualité`);
}

function jsonOutput(reports, totals, failed) {
  return {
    skills: reports.map((report) => ({
      skill: report.skillPath,
      nom: report.name,
      constats: report.findings.map((finding) => ({
        niveau: JSON_LEVELS[finding.level],
        regle: finding.rule,
        message: finding.message,
        ...(finding.line ? { ligne: finding.line } : {}),
      })),
    })),
    total: { erreurs: totals.errors, securite: totals.security, qualite: totals.quality },
    echec: failed,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) return console.log(HELP);
  const folders = await findSkills(options.paths);
  if (!folders.length) throw new Error(`Aucun SKILL.md trouvé dans : ${options.paths.join(', ')}`);
  const reports = [];
  for (const folder of folders) {
    const skill = await readSkill(folder);
    reports.push({
      skillPath: relative(process.cwd(), folder) || '.',
      name: skill.header && skill.header.name,
      findings: checkSkill(skill, { maxLines: options.maxLines }),
    });
  }
  const countLevel = (level) => reports.reduce((count, report) => count + report.findings.filter((finding) => finding.level === level).length, 0);
  const totals = { errors: countLevel('error'), security: countLevel('security'), quality: countLevel('quality') };
  const failed = totals.errors > 0 || (options.strict && totals.security > 0);

  if (options.json) console.log(JSON.stringify(jsonOutput(reports, totals, failed), null, 2));
  else printText(reports, totals);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`olympe : ${error.message}`);
  process.exit(1);
});
