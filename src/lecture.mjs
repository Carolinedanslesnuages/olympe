/** Trouver les skills et lire leur SKILL.md (en-tête YAML + corps Markdown). */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { parse } from 'yaml';

const IGNORES = new Set(['node_modules', '.git', 'dist']);

/** Dossiers de skill (ceux qui contiennent un SKILL.md) sous chaque chemin donné. */
export async function trouverSkills(chemins) {
  const trouves = new Set();
  async function parcourir(d) {
    let entrees;
    try {
      entrees = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (entrees.some((e) => e.isFile() && e.name === 'SKILL.md')) trouves.add(d);
    for (const e of entrees) if ((e.isDirectory() || e.isSymbolicLink()) && !IGNORES.has(e.name)) await parcourir(join(d, e.name));
  }
  for (const c of chemins) {
    const absolu = resolve(c);
    const s = await stat(absolu).catch(() => null);
    if (!s) throw new Error(`Chemin introuvable : ${c}`);
    if (s.isFile()) {
      if (basename(absolu) !== 'SKILL.md') throw new Error(`${c} n'est pas un SKILL.md`);
      trouves.add(dirname(absolu));
    } else await parcourir(absolu);
  }
  return [...trouves].sort();
}

/**
 * Sépare l'en-tête YAML du corps. Renvoie { entete, corps, erreurYaml, sansEntete }.
 * Le corps garde ses numéros de ligne d'origine (decalage) pour des messages précis.
 */
export function decouper(texte) {
  const propre = texte.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(propre);
  if (!m) return { entete: null, corps: propre, sansEntete: true, decalage: 0 };
  const decalage = m[0].split('\n').length - 1;
  try {
    const entete = parse(m[1]);
    return { entete: entete ?? {}, corps: propre.slice(m[0].length), decalage };
  } catch (e) {
    return { entete: null, corps: propre.slice(m[0].length), erreurYaml: e.message.split('\n')[0], decalage };
  }
}

export async function lireSkill(dossier) {
  const texte = await readFile(join(dossier, 'SKILL.md'), 'utf8');
  return { dossier, nomDossier: basename(dossier), texte, ...decouper(texte) };
}
