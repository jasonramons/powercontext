import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
const hfEndpoint = import.meta.env.VITE_HF_ENDPOINT as string | undefined;
if (hfEndpoint) {
  env.remoteHost = hfEndpoint;
}

export const MODEL_ID = (import.meta.env.VITE_MODEL_ID as string) || 'Xenova/all-MiniLM-L6-v2';
export const EMBED_DIM = 384;

export type Device = 'webgpu' | 'wasm';
export type Dtype = 'fp16' | 'q8';

export interface EmbedderInfo {
  model: string;
  device: Device;
  dtype: Dtype;
  loadMs: number;
  fallbackReason?: string;
}

/** Prefer WebGPU; fall back to WASM when there is no adapter or probing throws. */
export async function detectDevice(): Promise<{ device: Device; fallbackReason?: string }> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
  if (!gpu) return { device: 'wasm', fallbackReason: 'navigator.gpu 不可用' };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { device: 'wasm', fallbackReason: '未取到 GPU 适配器' };
    return { device: 'webgpu' };
  } catch (err) {
    return { device: 'wasm', fallbackReason: `WebGPU 探测失败: ${String((err as Error)?.message ?? err)}` };
  }
}

export async function createEmbedder(options: {
  device: Device;
  onProgress?: (info: { status: string; file?: string; progress?: number }) => void;
}): Promise<{ embed: (texts: string[]) => Promise<number[][]>; info: EmbedderInfo }> {
  const { device, onProgress } = options;
  // fp16 halves the weights on WebGPU; q8 is the smallest option for the WASM backend.
  const dtype: Dtype = device === 'webgpu' ? 'fp16' : 'q8';
  const started = performance.now();
  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    device,
    dtype,
    progress_callback: (info: { status: string; file?: string; progress?: number }) => onProgress?.(info),
  });
  const loadMs = performance.now() - started;

  const embed = async (texts: string[]): Promise<number[][]> => {
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist() as number[][];
  };

  return { embed, info: { model: MODEL_ID, device, dtype, loadMs } };
}
