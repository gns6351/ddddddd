'use strict';
const fs = require('fs');
const path = require('path');
const { sha256hex } = require('./util');

/** 머리말(--- ... ---) 파싱: key: value, key: [a, b] */
function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('front matter missing');
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i < 0) throw new Error(`bad front matter line: ${line}`);
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    meta[k] = v;
  }
  return { meta, body: m[2] };
}

function loadPrompt(contentDir, name, version) {
  const dir = path.join(contentDir, 'prompts', name);
  const file = path.join(dir, `${version}.md`);
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontMatter(raw);
  if (meta.id !== name || meta.version !== version) throw new Error(`prompt header mismatch in ${file}`);
  const schemaRaw = fs.readFileSync(path.join(dir, meta.output_schema), 'utf8');
  const examplesRaw = fs.readFileSync(path.join(dir, meta.examples), 'utf8');
  const variables = Array.isArray(meta.variables) ? meta.variables : [];
  const used = [...body.matchAll(/\{\{(\w+)\}\}/g)].map((x) => x[1]);
  const errors = [];
  for (const v of variables) if (!used.includes(v)) errors.push(`variable {{${v}}} not used in body`);
  for (const v of used) if (v !== 'examples' && !variables.includes(v)) errors.push(`undeclared variable {{${v}}}`);
  if (!used.includes('examples')) errors.push('{{examples}} slot missing');
  return {
    id: name,
    version,
    ref: `${name}@${version}`,
    temperature: meta.temperature,
    thinking: meta.thinking,
    variables,
    body,
    schema: JSON.parse(schemaRaw),
    examples: JSON.parse(examplesRaw),
    hash: sha256hex(raw + '\n' + schemaRaw + '\n' + examplesRaw),
    errors,
  };
}

/** 등록된(config.prompts) 버전만 호출 가능 */
function createPromptRegistry(contentDir, registered) {
  const cache = new Map();
  const get = (name) => {
    const version = registered[name];
    if (!version) throw new Error(`prompt not registered: ${name}`);
    const key = `${name}@${version}`;
    if (!cache.has(key)) cache.set(key, loadPrompt(contentDir, name, version));
    return cache.get(key);
  };
  return { get, render: (name, vars) => renderPrompt(get(name), vars), loadVersion: (name, version) => loadPrompt(contentDir, name, version) };
}

/** 단일 패스 치환: 조언 원문 속 {{...}}는 다시 해석하지 않음(데이터로 취급) */
function renderPrompt(p, vars) {
  const examples = p.examples.map((e) => JSON.stringify(e, null, 0)).join('\n');
  return p.body.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (k === 'examples') return examples;
    if (!(k in vars)) throw new Error(`missing variable ${k}`);
    return String(vars[k]);
  });
}

module.exports = { createPromptRegistry, parseFrontMatter, loadPrompt, renderPrompt };
