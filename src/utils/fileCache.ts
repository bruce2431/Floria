import { join } from 'path'
import { getProjectRoot, getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * 会话缓存（image-cache 已升级并入）：<会话启动根>/.claude/file-cache/<会话 uuid>/。
 * 同一目录取两类键：粘贴图片 = <id>.<ext>（imageStore 落盘），上传附件 = 原名 + 时间戳
 * （网关 /gateway/file-cache 落盘）。读写/清理只有一套规则。
 * projectRoot 由调用方显式给出：CLI = getProjectRoot()（进程启动 cwd = 会话根），
 * 网关 = 由请求 sid 解出的会话启动根（不可用网关自身 cwd 代替）。
 */
export const FILE_CACHE_DIR = 'file-cache'
/** 尚无会话归属的上传（首页首送前）落此目录；它不是旧会话，清理时跳过。 */
export const PENDING_FILE_DIR = '_pending'

export function getFileCacheDir(projectRoot: string, dirKey: string): string {
  return join(projectRoot, '.claude', FILE_CACHE_DIR, dirKey)
}

/** CLI 侧（图片落盘）：当前进程的会话根。 */
export function getSessionFileCacheDir(dirKey: string = getSessionId()): string {
  return getFileCacheDir(getProjectRoot(), dirKey)
}

/**
 * 清理本项目非当前会话的附件缓存目录（与旧 image-cache 同一时机与粒度）。
 * 只扫 <getProjectRoot()>/.claude/file-cache——各项目只清自己的。
 */
export async function cleanupOldFileCaches(): Promise<void> {
  const fsImpl = getFsImplementation()
  const baseDir = join(getProjectRoot(), '.claude', FILE_CACHE_DIR)
  const currentSessionId = getSessionId()

  try {
    let sessionDirs
    try {
      sessionDirs = await fsImpl.readdir(baseDir)
    } catch {
      return
    }

    for (const sessionDir of sessionDirs) {
      if (sessionDir.name === currentSessionId || sessionDir.name === PENDING_FILE_DIR) {
        continue
      }

      const sessionPath = join(baseDir, sessionDir.name)
      try {
        await fsImpl.rm(sessionPath, { recursive: true, force: true })
        logForDebugging(`Cleaned up old file cache: ${sessionPath}`)
      } catch {
        // Ignore errors for individual directories
      }
    }

    try {
      const remaining = await fsImpl.readdir(baseDir)
      if (remaining.length === 0) {
        await fsImpl.rmdir(baseDir)
      }
    } catch {
      // Ignore
    }
  } catch {
    // Ignore errors reading base directory
  }
}
