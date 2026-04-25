import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { backupSandboxArchive, restoreSandboxArchive } from "./sandboxFiles"

const BACKUP_DIR = process.env.SANDBOX_BACKUP_DIR || path.join(process.cwd(), ".runtime", "backups")
const MAX_BACKUP_COUNT = Number.parseInt(process.env.SANDBOX_BACKUP_CATALOG_MAX || "100", 10)

export type BackupCatalogEntry = {
  id: string
  fileName: string
  sandboxId: string
  sandboxName: string
  sourcePath: string
  size: number
  createdAt: string
}

function sanitizeSegment(value: string) {
  return value.trim().replace(/[^\w.@:+-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "backup"
}

function archivePath(id: string) {
  return path.join(BACKUP_DIR, `${id}.tar.gz`)
}

function metadataPath(id: string) {
  return path.join(BACKUP_DIR, `${id}.json`)
}

async function ensureBackupDirectory() {
  await mkdir(BACKUP_DIR, { recursive: true })
}

export async function listBackupCatalog() {
  await ensureBackupDirectory()
  const names = await readdir(BACKUP_DIR).catch(() => [])
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const metadata = JSON.parse(await readFile(path.join(BACKUP_DIR, name), "utf8")) as BackupCatalogEntry
          await stat(archivePath(metadata.id))
          return metadata
        } catch {
          return null
        }
      }),
  )

  return entries
    .filter((entry): entry is BackupCatalogEntry => Boolean(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function createCatalogBackup(sandboxId: string, sourcePath: string) {
  await ensureBackupDirectory()
  const archive = await backupSandboxArchive(sandboxId, sourcePath)
  const id = `${sanitizeSegment(archive.sandboxName)}-${Date.now().toString(36)}`
  const entry: BackupCatalogEntry = {
    id,
    fileName: archive.fileName,
    sandboxId,
    sandboxName: archive.sandboxName,
    sourcePath: archive.sourcePath,
    size: archive.bytes.byteLength,
    createdAt: archive.createdAt,
  }

  await writeFile(archivePath(id), archive.bytes)
  await writeFile(metadataPath(id), `${JSON.stringify(entry, null, 2)}\n`)

  const entries = await listBackupCatalog()
  await Promise.all(entries.slice(MAX_BACKUP_COUNT).map((stale) => deleteCatalogBackup(stale.id).catch(() => undefined)))

  return entry
}

export async function getCatalogBackup(id: string) {
  const safeId = sanitizeSegment(id)
  const metadata = JSON.parse(await readFile(metadataPath(safeId), "utf8")) as BackupCatalogEntry
  const bytes = await readFile(archivePath(safeId))
  return { metadata, bytes }
}

export async function restoreCatalogBackup(id: string, targetSandboxId: string, targetPath: string, replace: boolean) {
  const backup = await getCatalogBackup(id)
  return restoreSandboxArchive(targetSandboxId, targetPath, backup.metadata.fileName, backup.bytes, replace)
}

export async function deleteCatalogBackup(id: string) {
  const safeId = sanitizeSegment(id)
  await Promise.all([
    rm(archivePath(safeId), { force: true }),
    rm(metadataPath(safeId), { force: true }),
  ])
  return { id: safeId }
}
