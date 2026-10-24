import { join } from 'path'
import { mkdir, open } from 'fs/promises'
import { getSessionId } from '../bootstrap/state.js'
import type { PastedContent } from './config.js'
import { logForDebugging } from './debug.js'
import { getSessionFileCacheDir } from './fileCache.js'

const MAX_STORED_IMAGE_PATHS = 200

// In-memory cache of stored image paths
const storedImagePaths = new Map<number, string>()

/**
 * Get the image store directory for the current session.
 * 2026-10-24：image-cache 升级为 file-cache——粘贴图片与上传附件共用同一会话目录
 * （图片 = <id>.<ext>，附件 = 原名+时间戳），读写/清理只有一套规则。
 */
function getImageStoreDir(): string {
  return getSessionFileCacheDir(getSessionId())
}

/**
 * Ensure the image store directory exists.
 */
async function ensureImageStoreDir(): Promise<void> {
  const dir = getImageStoreDir()
  await mkdir(dir, { recursive: true })
}

/**
 * Get the file path for an image by ID.
 */
function getImagePath(imageId: number, mediaType: string): string {
  const extension = mediaType.split('/')[1] || 'png'
  return join(getImageStoreDir(), `${imageId}.${extension}`)
}

/**
 * Cache the image path immediately (fast, no file I/O).
 */
export function cacheImagePath(content: PastedContent): string | null {
  if (content.type !== 'image') {
    return null
  }
  const imagePath = getImagePath(content.id, content.mediaType || 'image/png')
  evictOldestIfAtCap()
  storedImagePaths.set(content.id, imagePath)
  return imagePath
}

/**
 * Store an image from pastedContents to disk.
 */
export async function storeImage(
  content: PastedContent,
): Promise<string | null> {
  if (content.type !== 'image') {
    return null
  }

  try {
    await ensureImageStoreDir()
    const imagePath = getImagePath(content.id, content.mediaType || 'image/png')
    const fh = await open(imagePath, 'w', 0o600)
    try {
      await fh.writeFile(content.content, { encoding: 'base64' })
      await fh.datasync()
    } finally {
      await fh.close()
    }
    evictOldestIfAtCap()
    storedImagePaths.set(content.id, imagePath)
    logForDebugging(`Stored image ${content.id} to ${imagePath}`)
    return imagePath
  } catch (error) {
    logForDebugging(`Failed to store image: ${error}`)
    return null
  }
}

/**
 * Store all images from pastedContents to disk.
 */
export async function storeImages(
  pastedContents: Record<number, PastedContent>,
): Promise<Map<number, string>> {
  const pathMap = new Map<number, string>()

  for (const [id, content] of Object.entries(pastedContents)) {
    if (content.type === 'image') {
      const path = await storeImage(content)
      if (path) {
        pathMap.set(Number(id), path)
      }
    }
  }

  return pathMap
}

/**
 * Get the file path for a stored image by ID.
 */
export function getStoredImagePath(imageId: number): string | null {
  return storedImagePaths.get(imageId) ?? null
}

/**
 * Clear the in-memory cache of stored image paths.
 */
export function clearStoredImagePaths(): void {
  storedImagePaths.clear()
}

function evictOldestIfAtCap(): void {
  while (storedImagePaths.size >= MAX_STORED_IMAGE_PATHS) {
    const oldest = storedImagePaths.keys().next().value
    if (oldest !== undefined) {
      storedImagePaths.delete(oldest)
    } else {
      break
    }
  }
}

