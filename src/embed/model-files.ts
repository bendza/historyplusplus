// The embedding model is downloaded once, on demand, from the Hugging Face Hub at a pinned commit
// and kept in Cache Storage. Every file is checked against its size and SHA-256 before it is
// stored, so what runs is exactly this revision. Keep in sync with scripts/fetch-model.sh.
import { EMBED_MODEL } from '../shared/protocol';

export const MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const MODEL_HOST = 'https://huggingface.co/';

// Cache Storage bucket. The embed worker gives this name to transformers.js (env.cacheKey), which
// looks files up by their remote URL (`${MODEL_HOST}${model}/resolve/${revision}/${file}`).
export const MODEL_CACHE = `history-pp-model-${MODEL_REVISION.slice(0, 12)}`;

export interface ModelFile {
  path: string;
  size: number;
  sha256: string;
}

// q8 = onnx/model_quantized.onnx. Sizes/hashes from the HF API for MODEL_REVISION.
export const MODEL_FILES: readonly ModelFile[] = [
  { path: 'config.json', size: 658, sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1' },
  { path: 'tokenizer_config.json', size: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
  { path: 'special_tokens_map.json', size: 167, sha256: 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7' },
  { path: 'tokenizer.json', size: 17_082_730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
  { path: 'onnx/model_quantized.onnx', size: 118_308_185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
];

export const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((n, f) => n + f.size, 0);

/**
 * Hosts the download may touch (manifest CSP connect-src). huggingface.co answers the resolve URL
 * and 302-redirects large (LFS/Xet) files to a CDN; which CDN host depends on region and on HF's
 * storage migration, so all of HF's current file CDNs are listed. Verified 2026-10-14: small files
 * 307 -> huggingface.co/api/resolve-cache/..., large files 302 -> us.aws.cdn.hf.co.
 */
export const MODEL_CONNECT_HOSTS = [
  'https://huggingface.co',
  'https://us.aws.cdn.hf.co',
  'https://cas-bridge.xethub.hf.co',
  'https://cdn-lfs.hf.co',
  'https://cdn-lfs-us-1.hf.co',
  'https://cdn-lfs-eu-1.hf.co',
] as const;

export function modelFileUrl(path: string): string {
  return `${MODEL_HOST}${EMBED_MODEL}/resolve/${MODEL_REVISION}/${path}`;
}
