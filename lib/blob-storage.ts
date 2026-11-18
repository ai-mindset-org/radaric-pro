/* eslint-disable @typescript-eslint/no-explicit-any -- GramJS has no exported types for messages, media and documents */
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';

/**
 * Result of media upload.
 * `thumbUrl` carries the poster (document thumbnail) when one was mirrored,
 * and equals `url` for photos (whose body is the image).
 */
export interface UploadedMedia {
  url: string;
  type: 'photo' | 'video' | 'audio' | 'document';
  thumbUrl: string | null;
}

type TelegramMediaType = 'photo' | 'video' | 'audio' | 'document';

/**
 * Configuration for media upload
 */
const UPLOAD_CONFIG = {
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB max file size
  DOWNLOAD_TIMEOUT: 60000, // 60 seconds (Railway has no serverless limits)
  UPLOAD_TIMEOUT: 30000, // 30 seconds timeout for upload to R2
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
};

/** Thumbs below this size are treated as unusable noise. */
const MIN_THUMB_SIZE = 2048;

/**
 * Lazy-initialized S3 client for Cloudflare R2
 */
let _s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!_s3Client) {
    const endpoint = process.env.R2_ENDPOINT;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'Missing R2 configuration. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY env vars.'
      );
    }

    _s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }
  return _s3Client;
}

function getBucketName(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) {
    throw new Error('Missing R2_BUCKET_NAME env var.');
  }
  return bucket;
}

function getPublicUrl(key: string): string {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) {
    throw new Error('Missing R2_PUBLIC_URL env var.');
  }
  return `${publicUrl.replace(/\/$/, '')}/${key}`;
}

/**
 * Helper: Execute function with timeout
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * Helper: Retry function with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = UPLOAD_CONFIG.MAX_RETRIES,
  initialDelay: number = UPLOAD_CONFIG.RETRY_DELAY
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms: ${lastError.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Failed after retries');
}

/**
 * Upload a buffer to Cloudflare R2
 */
async function uploadToR2(
  key: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  const client = getS3Client();
  const bucket = getBucketName();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return getPublicUrl(key);
}

/** Existence-check timeout: a slow HEAD must not eat the media budget. */
const HEAD_TIMEOUT_MS = 5000;

/** Three-state answer for a HEAD: only a real 404 proves the key is absent. */
export type R2ObjectState = "exists" | "absent" | "unknown";

/**
 * Whether a HEAD failure is the bucket saying "no such key".
 *
 * Anything else — a timeout, a 403 from a token without read rights, a network
 * error — proves nothing for a caller that might delete the object.
 */
function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    e.$metadata?.httpStatusCode === 404 ||
    e.name === "NotFound" ||
    e.name === "NoSuchKey" ||
    e.Code === "NotFound" ||
    e.Code === "NoSuchKey"
  );
}

/**
 * Whether an object sits at `key` — fail-CLOSED, for callers that must decide
 * whether an object is theirs to delete.
 *
 * Only a real 404/NotFound answers `absent`; every other failure is `unknown`
 * and must be treated as "leave it alone". The uploader keeps the fail-open
 * {@link r2ObjectExists} instead: an unreadable bucket must not stop a mirror.
 */
export async function r2ObjectState(key: string): Promise<R2ObjectState> {
  try {
    const client = getS3Client();
    await withTimeout(
      client.send(new HeadObjectCommand({ Bucket: getBucketName(), Key: key })),
      HEAD_TIMEOUT_MS,
      `HEAD timeout after ${HEAD_TIMEOUT_MS}ms`
    );
    return "exists";
  } catch (error) {
    return isNotFoundError(error) ? "absent" : "unknown";
  }
}

/**
 * Whether an object already sits at `key`. Fails open: any error (404, a
 * token without read rights, a timeout) answers `false`, so the caller mirrors
 * exactly as it would have without the check.
 */
export async function r2ObjectExists(key: string): Promise<boolean> {
  return (await r2ObjectState(key)) === "exists";
}

/**
 * Whether a pre-upload state proves the caller created the object, i.e. whether
 * it may delete it afterwards. Only `absent` does — `exists` is someone else's
 * object and `unknown` could be, so both must be left in place.
 */
export function createdByCaller(state: R2ObjectState): boolean {
  return state === "absent";
}

/**
 * Delete an object from Cloudflare R2
 */
async function deleteFromR2(key: string): Promise<void> {
  const client = getS3Client();
  const bucket = getBucketName();

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}

/**
 * The R2 keys `uploadTelegramMedia` / `uploadTelegramThumb` use for a message.
 *
 * One formula, so a caller that must decide whether an object is already there
 * (the live probe) asks the same question the uploader answers. `thumb` is null
 * for photos (their body is the poster) and for documents without thumbs.
 */
export function telegramMediaKeys(
  message: any,
  channelUsername: string
): { body: string; thumb: string | null } {
  const mediaType = getMediaType(message.media);
  const extension = getMediaExtension(message.media, mediaType);
  const cleanChannelUsername = channelUsername.replace(/^\/+|\/+$/g, '').trim();

  return {
    body: `telegram/${cleanChannelUsername}/${message.id}.${extension}`,
    thumb:
      mediaType !== 'photo' && hasDocumentThumbs(message.media)
        ? `telegram/${cleanChannelUsername}/${message.id}_thumb.jpg`
        : null,
  };
}

/**
 * Upload Telegram media to Cloudflare R2 with timeout and retry
 * @param client - Telegram client instance
 * @param message - Telegram message with media
 * @param channelUsername - Channel username for folder organization
 * @returns Public URL of uploaded media
 */
export async function uploadTelegramMedia(
  client: TelegramClient,
  message: any,
  channelUsername: string
): Promise<UploadedMedia> {
  try {
    const mediaType = getMediaType(message.media);
    const extension = getMediaExtension(message.media, mediaType);

    const cleanChannelUsername = channelUsername.replace(/^\/+|\/+$/g, '').trim();

    if (!cleanChannelUsername) {
      throw new Error(`Channel username cannot be empty (received: "${channelUsername}")`);
    }

    if (!message.id) {
      throw new Error(`Message ID is missing for channel ${cleanChannelUsername}`);
    }

    // Organized folder structure; the key is a function of the message alone.
    const key = telegramMediaKeys(message, cleanChannelUsername).body;

    // Every parse re-reads the channel's latest posts, and the dedup that skips
    // stored rows runs only after the worker answers. Without this check each
    // re-parse would download every already-mirrored video again and spend the
    // media budget on them, starving the posts that still need theirs.
    let url: string;
    if (await r2ObjectExists(key)) {
      url = getPublicUrl(key);
    } else {
      // A link preview's own `document` wins over its photo inside GramJS's
      // `downloadMedia`, so hand it the photo — the type and `.jpg` key above
      // are the photo's.
      const downloadTarget =
        message.media?.className === 'MessageMediaWebPage' && message.media.webpage?.photo
          ? message.media.webpage.photo
          : message.media;

      // Download media from Telegram with timeout and retry
      const buffer = await withRetry(
        () => withTimeout(
          client.downloadMedia(downloadTarget),
          UPLOAD_CONFIG.DOWNLOAD_TIMEOUT,
          `Download timeout after ${UPLOAD_CONFIG.DOWNLOAD_TIMEOUT}ms`
        )
      );

      // Zero bytes (a `PhotoEmpty`) must never be stored: the existence check
      // above would keep serving the empty object on every later parse.
      if (!buffer || !(buffer instanceof Buffer) || buffer.length === 0) {
        throw new Error('Failed to download media: buffer is empty or invalid');
      }

      const fileSizeMB = (buffer.length / 1024 / 1024).toFixed(2);
      console.log(`Downloaded ${mediaType} for message ${message.id}: ${fileSizeMB}MB`);

      if (buffer.length > UPLOAD_CONFIG.MAX_FILE_SIZE) {
        throw new Error(
          `File too large: ${fileSizeMB}MB (max: ${UPLOAD_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB)`
        );
      }

      const contentType = getContentType(extension);

      console.log(`[R2 Storage] Uploading to key: ${key}`);

      url = await withTimeout(
        uploadToR2(key, buffer, contentType),
        UPLOAD_CONFIG.UPLOAD_TIMEOUT,
        `Upload timeout after ${UPLOAD_CONFIG.UPLOAD_TIMEOUT}ms`
      );

      console.log(`Successfully uploaded ${mediaType} to R2: ${url}`);
    }

    // Photos are their own poster; documents carry a separate thumbnail.
    const thumbUrl =
      mediaType === 'photo'
        ? url
        : hasDocumentThumbs(message.media)
          ? await uploadTelegramThumb(client, message, channelUsername)
          : null;

    return { url, type: mediaType, thumbUrl };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error uploading media for message ${message.id}:`, errorMessage);
    throw error;
  }
}

/**
 * Upload a document's poster (thumb) to R2 as `{messageId}_thumb.jpg`.
 *
 * Never throws: a message without document thumbs, a failed/garbage download,
 * or a rejected R2 upload all resolve to `null` so a poster can never sink the
 * body upload. A thumb smaller than {@link MIN_THUMB_SIZE} is treated as noise.
 */
export async function uploadTelegramThumb(
  client: TelegramClient,
  message: any,
  channelUsername: string
): Promise<string | null> {
  try {
    if (!hasDocumentThumbs(message.media)) return null;

    const cleanChannelUsername = channelUsername.replace(/^\/+|\/+$/g, '').trim();
    if (!cleanChannelUsername || !message.id) return null;

    const key = telegramMediaKeys(message, cleanChannelUsername).thumb;
    if (!key) return null;
    if (await r2ObjectExists(key)) return getPublicUrl(key);

    // GramJS sorts thumbs ascending (`getThumb`), so the last index is the largest.
    const largestThumbIndex = message.media.document.thumbs.length - 1;

    const buffer = await withTimeout(
      client.downloadMedia(message.media, { thumb: largestThumbIndex }),
      UPLOAD_CONFIG.DOWNLOAD_TIMEOUT,
      `Thumb download timeout after ${UPLOAD_CONFIG.DOWNLOAD_TIMEOUT}ms`
    );

    if (!buffer || !(buffer instanceof Buffer) || buffer.length < MIN_THUMB_SIZE) {
      return null;
    }

    return await withTimeout(
      uploadToR2(key, buffer, 'image/jpeg'),
      UPLOAD_CONFIG.UPLOAD_TIMEOUT,
      `Thumb upload timeout after ${UPLOAD_CONFIG.UPLOAD_TIMEOUT}ms`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error uploading thumb for message ${message?.id}:`, errorMessage);
    return null;
  }
}

/**
 * Upload multiple media files (for media groups/albums)
 */
export async function uploadMultipleMedia(
  client: TelegramClient,
  message: any,
  channelUsername: string
): Promise<string[]> {
  const urls: string[] = [];

  if (message.media) {
    try {
      const result = await uploadTelegramMedia(client, message, channelUsername);
      urls.push(result.url);
    } catch (error) {
      console.error(`Failed to upload media for message ${message.id}:`, error);
      urls.push(`tg://photo/${message.id}`);
    }
  }

  return urls;
}

/**
 * Delete media from R2 storage
 */
export async function deleteTelegramMedia(url: string): Promise<void> {
  try {
    const key = extractR2Key(url);
    if (key) {
      await deleteFromR2(key);
    }
  } catch (error) {
    console.error('Error deleting media from R2:', error);
    throw error;
  }
}

/**
 * Extract the R2 object key from a public URL.
 *
 * Only a URL whose host is EXACTLY the host of `R2_PUBLIC_URL` is ours. A
 * suffix match on `*.r2.dev` used to trust any zone (and `startsWith` on the
 * raw string trusted `https://media.example.test.evil.com`), which let a
 * media URL taken from feed content name a key of ours. Legacy Vercel Blob
 * URLs stay readable for migration compat.
 */
function extractR2Key(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (isR2Host(parsed)) {
      return parsed.pathname.slice(1); // remove leading /
    }

    // Vercel Blob URL: extract path after the host
    if (isVercelBlobHost(parsed.hostname)) {
      return parsed.pathname.slice(1);
    }
  } catch {
    // Invalid URL
  }
  return null;
}

/**
 * Whether `hostname` belongs to Vercel Blob. A suffix on the PARSED hostname,
 * not a substring: `x.vercel-storage.com.evil.io` is not Vercel's.
 */
function isVercelBlobHost(hostname: string): boolean {
  return hostname === 'vercel-storage.com' || hostname.endsWith('.vercel-storage.com');
}

/** Whether `parsed` points at the bucket behind `R2_PUBLIC_URL` — exact host. */
function isR2Host(parsed: URL): boolean {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) return false;
  try {
    return parsed.host === new URL(publicUrl).host;
  } catch {
    // A malformed R2_PUBLIC_URL manages nothing.
    return false;
  }
}

/**
 * Check if URL is a managed storage URL (R2 or legacy Vercel Blob).
 *
 * No production caller since RAD-368 removed `deleteMultipleMedia`: kept as the
 * predicate a GC sweep should gate on. Treat any new caller as a trust boundary.
 */
export function isStorageUrl(url: string): boolean {
  return isR2Url(url) || isVercelBlobUrl(url);
}

/**
 * Check if URL is a Cloudflare R2 URL.
 *
 * Exact host match against `R2_PUBLIC_URL` only — see {@link extractR2Key}.
 */
export function isR2Url(url: string): boolean {
  try {
    return isR2Host(new URL(url));
  } catch {
    return false;
  }
}

/**
 * Check if URL is a legacy Vercel Blob storage URL
 * @deprecated Will be removed after migration is complete
 */
export function isVercelBlobUrl(url: string): boolean {
  try {
    return isVercelBlobHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Check if URL is a Blob storage URL (backward compat alias)
 * @deprecated Use isStorageUrl instead
 */
export function isBlobStorageUrl(url: string): boolean {
  return isStorageUrl(url);
}

/**
 * Extract channel username and message ID from storage path
 * @param url - Storage URL (R2 or legacy Vercel Blob)
 * @returns Object with channelUsername and messageId, or null if not parseable
 */
export function parseBlobUrl(url: string): { channelUsername: string; messageId: number } | null {
  try {
    const match = url.match(/telegram\/([^\/]+)\/(\d+)\./);
    if (match) {
      return {
        channelUsername: match[1],
        messageId: parseInt(match[2], 10),
      };
    }
  } catch (error) {
    console.error('Error parsing storage URL:', error);
  }
  return null;
}

/**
 * Upload a generic buffer to R2 under a given key.
 * Used for source cover photos (Telegram channel avatars).
 */
export async function uploadBufferToR2(
  key: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  return uploadToR2(key, buffer, contentType);
}

// ---------------------------------------------------------------------------
// Telegram media helpers
// ---------------------------------------------------------------------------

/** Mime type → canonical file extension. */
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-wav': 'wav',
  'application/pdf': 'pdf',
  'application/x-tgsticker': 'tgs',
};

/** File extension → Content-Type served from R2. */
const EXTENSION_TO_CONTENT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/x-wav',
  pdf: 'application/pdf',
  tgs: 'application/x-tgsticker',
  bin: 'application/octet-stream',
};

/** Strip mime parameters (`audio/ogg; codecs=opus`) and normalize case. */
function normalizeMime(mimeType: string | undefined): string {
  return (mimeType || '').split(';')[0].trim().toLowerCase();
}

function getMediaType(media: any): TelegramMediaType {
  const className = media?.className;

  if (className === 'MessageMediaPhoto') return 'photo';

  if (className === 'MessageMediaDocument') {
    const attrs = media.document?.attributes || [];
    if (attrs.some((attr: any) => attr.className === 'DocumentAttributeVideo')) return 'video';
    if (attrs.some((attr: any) => attr.className === 'DocumentAttributeAudio')) return 'audio';
    return 'document';
  }

  if (className === 'MessageMediaWebPage' && media.webpage?.photo) {
    return 'photo';
  }

  return 'document';
}

function getMediaExtension(media: any, type: TelegramMediaType): string {
  if (type === 'photo') return 'jpg';

  const attrs = media?.document?.attributes || [];
  const filenameAttr = attrs.find(
    (attr: any) => attr.className === 'DocumentAttributeFilename'
  );
  if (filenameAttr?.fileName) {
    const match = String(filenameAttr.fileName).match(/\.([a-z0-9]+)$/i);
    if (match) return match[1].toLowerCase();
  }

  const mimeType = normalizeMime(media?.document?.mimeType);
  if (MIME_TO_EXTENSION[mimeType]) return MIME_TO_EXTENSION[mimeType];

  return type === 'video' ? 'mp4' : 'bin';
}

function getContentType(extension: string): string {
  return EXTENSION_TO_CONTENT_TYPE[extension] || 'application/octet-stream';
}

function hasDocumentThumbs(media: any): boolean {
  const thumbs = media?.document?.thumbs;
  return Array.isArray(thumbs) && thumbs.length > 0;
}
