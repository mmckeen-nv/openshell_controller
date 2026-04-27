import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { NextResponse } from "next/server"
import { listActivity } from "@/app/lib/activityLog"
import { listBackupCatalog } from "@/app/lib/backupCatalog"
import { HOST_PATH, OPENSHELL_BIN } from "@/app/lib/hostCommands"

const execFileAsync = promisify(execFile)

export const dynamic = "force-dynamic"

async function run(command: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 10000,
      env: { ...process.env, PATH: HOST_PATH, NO_COLOR: "1", CLICOLOR: "0", CLICOLOR_FORCE: "0" },
    })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : "command failed",
    }
  }
}

export async function GET() {
  const [gitHead, gitStatus, sandboxList, activity, backups] = await Promise.all([
    run("git", ["rev-parse", "--short", "HEAD"]),
    run("git", ["status", "--short", "--branch"]),
    run(OPENSHELL_BIN, ["sandbox", "list"]),
    listActivity(75),
    listBackupCatalog(),
  ])

  const bundle = {
    generatedAt: new Date().toISOString(),
    dashboard: {
      cwd: process.cwd(),
      gitHead: gitHead.stdout || null,
      gitStatus: gitStatus.stdout || gitStatus.stderr,
      nodeEnv: process.env.NODE_ENV || null,
    },
    openshell: {
      sandboxList: sandboxList.ok ? sandboxList.stdout : null,
      error: sandboxList.ok ? null : sandboxList.stderr,
    },
    backups: backups.map((backup) => ({
      id: backup.id,
      fileName: backup.fileName,
      sandboxName: backup.sandboxName,
      sourcePath: backup.sourcePath,
      size: backup.size,
      createdAt: backup.createdAt,
    })),
    activity,
  }

  const fileName = `openshell-support-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${fileName}"`,
      "content-type": "application/json",
    },
  })
}
