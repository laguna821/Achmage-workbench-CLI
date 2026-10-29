// Images pasted or dropped into documents. Markdown gets a link (to the user's Cloudflare R2 bucket,
// or to a copy in the work folder); Word, PowerPoint and Excel embed the image in the file itself.

/**
 * The R2 settings as the UI sees them: never the secret access key, and the access key ID only as
 * a hint. `configured` when everything an upload needs is there.
 */
export type ImageUploadView = {
  configured: boolean;
  /**
   * How pictures reach the bucket: "worker" through a Cloudflare Worker with an API key (the CMDS
   * Eagle plugin's way: Worker URL, API Key, Public URL), "s3" with an R2 API token.
   */
  mode: ImageUploadMode;
  /** The Worker's address (worker mode), e.g. https://obsidian-eagle-uploader.<name>.workers.dev. */
  workerUrl: string;
  /** Whether the Worker's API key is saved (it is never sent back). */
  apiKeySet: boolean;
  accountId: string;
  /** First and last characters of the access key ID, e.g. "1a2b…9f0e"; null when none is saved. */
  accessKeyHint: string | null;
  secretSet: boolean;
  bucket: string;
  /** Public address of the bucket (r2.dev or a custom domain), without a trailing slash. */
  publicBaseUrl: string;
  /** Optional folder for the objects, e.g. "workbench/". */
  keyPrefix: string;
  updatedAt: number | null;
};

/**
 * What the settings form sends. A missing or empty `secretAccessKey` keeps the saved one, so the
 * other fields can be changed without typing the secret again.
 */
export type ImageUploadMode = "worker" | "s3";

export type ImageUploadInput = {
  mode?: ImageUploadMode;
  workerUrl?: string;
  /** The Worker's UPLOAD_API_KEY; empty keeps the saved one. */
  apiKey?: string;
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  publicBaseUrl?: string;
  keyPrefix?: string;
};

/** "연결 확인": put a small file with the keys, open it at the public address, delete it. */
export type ImageUploadCheck = {
  ok: boolean;
  steps: { step: "settings" | "worker" | "upload" | "public" | "cleanup"; ok: boolean; message: string }[];
};

/** One image put into a Markdown document. */
export type DocImageResult = {
  /** The line to insert: `![alt](url)`. */
  markdown: string;
  url: string;
  alt: string;
  /** "r2": uploaded to the bucket; "local": saved in the work folder's assets/. */
  stored: "r2" | "local";
  /** Why the image was not uploaded although R2 is set up (it was saved in the work folder instead). */
  fallback?: string;
};
