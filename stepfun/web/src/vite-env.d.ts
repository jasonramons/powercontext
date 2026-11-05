/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MODEL_ID?: string;
  readonly VITE_HF_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
