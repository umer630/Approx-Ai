// Product model catalog (backend/config/models.json): models, kinds, capabilities, pipelines and the
// efficiency modes. Loaded once at start-up and validated — a broken catalog stops the server rather
// than serving half-configured models.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.APPROX_MODEL_CATALOG || path.resolve(here, '../config/models.json');

export const MODEL_KINDS = ['language_model', 'code_model', 'multimodal_model', 'video_pipeline'];
const TIERS = ['default', 'advanced', 'premium', 'restricted'];
const MODE_FIELDS = ['max_tokens', 'temperature', 'top_p', 'frequency_penalty', 'context_chars'];

function fail(msg) { throw new Error(`Invalid model catalog (${file}): ${msg}`); }

function load() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(e.message); }
  if (raw.schema !== 'approx.catalog/v1') fail('schema must be approx.catalog/v1');

  const modes = raw.efficiency_modes;
  if (!modes || typeof modes !== 'object' || !Object.keys(modes).length) fail('efficiency_modes is required');
  for (const [id, m] of Object.entries(modes)) {
    if (!/^[a-z]{2,12}$/.test(id)) fail(`bad mode id '${id}'`);
    for (const f of MODE_FIELDS) if (typeof m[f] !== 'number' || !Number.isFinite(m[f])) fail(`mode ${id}.${f} must be a number`);
    if (m.max_tokens < 16 || m.max_tokens > 32768) fail(`mode ${id}.max_tokens out of range`);
    if (m.temperature < 0 || m.temperature > 2) fail(`mode ${id}.temperature out of range`);
    if (m.frequency_penalty < 0 || m.frequency_penalty > 2) fail(`mode ${id}.frequency_penalty out of range`);
    if (typeof m.label !== 'string' || typeof m.guidance !== 'string') fail(`mode ${id} needs label and guidance`);
  }
  if (!modes[raw.default_mode]) fail(`default_mode '${raw.default_mode}' is not an efficiency mode`);

  const pipelines = Array.isArray(raw.pipelines) ? raw.pipelines : [];
  for (const p of pipelines) {
    if (!/^[a-z0-9-]{2,40}$/.test(p.id || '')) fail(`bad pipeline id '${p.id}'`);
    if (!MODEL_KINDS.includes(p.kind)) fail(`pipeline ${p.id}: kind must be one of ${MODEL_KINDS.join(', ')}`);
    if (!Array.isArray(p.tasks) || !p.tasks.length) fail(`pipeline ${p.id}: tasks required`);
    if (!/^APPROX_[A-Z0-9_]+_URL$/.test(p.env_url || '')) fail(`pipeline ${p.id}: env_url must look like APPROX_*_URL`);
  }
  const pipelineIds = new Set(pipelines.map((p) => p.id));

  if (!Array.isArray(raw.models) || !raw.models.length) fail('models is required');
  const seen = new Set();
  for (const m of raw.models) {
    if (!/^[a-z0-9][a-z0-9.-]{1,40}$/.test(m.id || '')) fail(`bad model id '${m.id}'`);
    if (seen.has(m.id)) fail(`duplicate model id '${m.id}'`);
    seen.add(m.id);
    if (!m.name || !m.family || !m.description) fail(`model ${m.id}: name, family and description are required`);
    if (!TIERS.includes(m.tier)) fail(`model ${m.id}: tier must be one of ${TIERS.join(', ')}`);
    if (!MODEL_KINDS.includes(m.kind)) fail(`model ${m.id}: kind must be one of ${MODEL_KINDS.join(', ')}`);
    if (!Array.isArray(m.capabilities)) fail(`model ${m.id}: capabilities must be an array`);
    for (const p of m.pipelines || []) if (!pipelineIds.has(p)) fail(`model ${m.id}: unknown pipeline '${p}'`);
    for (const [mode, o] of Object.entries(m.mode_overrides || {})) {
      if (!modes[mode]) fail(`model ${m.id}: mode_overrides.${mode} is not an efficiency mode`);
      for (const k of Object.keys(o)) if (!MODE_FIELDS.includes(k)) fail(`model ${m.id}: mode_overrides.${mode}.${k} is not overridable`);
    }
  }
  return Object.freeze({ ...raw, models: raw.models, pipelines });
}

export const catalog = load();
export const MODES = Object.freeze(Object.keys(catalog.efficiency_modes));
export const DEFAULT_MODE = catalog.default_mode;

export function catalogModel(id) { return catalog.models.find((m) => m.id === id) || null; }
export function catalogPipeline(id) { return catalog.pipelines.find((p) => p.id === id) || null; }

/** Inference parameters for a model in a given efficiency mode (catalog defaults + per-model overrides). */
export function modeParams(modelId, mode) {
  const base = catalog.efficiency_modes[mode];
  if (!base) return null;
  const over = catalogModel(modelId)?.mode_overrides?.[mode] || {};
  return { ...base, ...over };
}

export function modeList() {
  return MODES.map((id) => {
    const m = catalog.efficiency_modes[id];
    return { id, label: m.label, description: m.description || '', max_tokens: m.max_tokens };
  });
}
