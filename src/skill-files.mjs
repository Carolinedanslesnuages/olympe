/** Finds skills and reads their SKILL.md (YAML header + Markdown body). */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { parse } from 'yaml';

const IGNORED = new Set(['node_modules', '.git', 'dist']);

/** Skill folders (those holding a SKILL.md) under each given path. */
export async function findSkills(paths) {
  const found = new Set();
  async function walk(folder) {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) found.add(folder);
    for (const entry of entries) {
      if ((entry.isDirectory() || entry.isSymbolicLink()) && !IGNORED.has(entry.name)) await walk(join(folder, entry.name));
    }
  }
  for (const path of paths) {
    const absolute = resolve(path);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`Chemin introuvable : ${path}`);
    if (info.isFile()) {
      if (basename(absolute) !== 'SKILL.md') throw new Error(`${path} n'est pas un SKILL.md`);
      found.add(dirname(absolute));
    } else await walk(absolute);
  }
  return [...found].sort();
}

/**
 * Splits the YAML header from the body. Returns { header, body, yamlError, missingHeader, lineOffset }.
 * The body keeps its original line numbers (lineOffset) for precise messages.
 */
export function splitSkill(text) {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { header: null, body: normalized, missingHeader: true, lineOffset: 0 };
  const lineOffset = match[0].split('\n').length - 1;
  try {
    const header = parse(match[1]);
    return { header: header ?? {}, body: normalized.slice(match[0].length), lineOffset };
  } catch (error) {
    return { header: null, body: normalized.slice(match[0].length), yamlError: error.message.split('\n')[0], lineOffset };
  }
}

export async function readSkill(folder) {
  const text = await readFile(join(folder, 'SKILL.md'), 'utf8');
  return { folder, folderName: basename(folder), text, ...splitSkill(text) };
}
