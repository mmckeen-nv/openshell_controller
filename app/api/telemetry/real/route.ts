import { NextResponse } from "next/server"

export async function GET() {
  try {
    // Use docker exec with a timeout and direct kubectl inside container
    const { exec } = await import('child_process')
    const util = await import('util')
    const execPromise = util.promisify(exec)

    const dockerPath = '/Applications/Docker.app/Contents/Resources/bin/docker'
    
    // Run kubectl inside container with explicit kubeconfig
    const command = `${dockerPath} exec openshell-cluster-openshell /bin/sh -c 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl get pods -o json -n agent-sandbox-system'`
    
    const execWithTimeout = (cmd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> => {
      return new Promise((resolve, reject) => {
        const child = exec(cmd, (error, stdout, stderr) => {
          if (error) {
            reject(error)
          } else {
            resolve({ stdout, stderr })
          }
        })
        
        setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('Command timed out'))
        }, timeoutMs)
      })
    }
    
    const { stdout, stderr } = await execWithTimeout(command, 10000)

    if (stderr && !stderr.includes('Waiting')) {
      console.error('kubectl stderr:', stderr)
    }

    if (!stdout.trim()) {
      throw new Error('No output from kubectl')
    }

    const pods = JSON.parse(stdout)
    
    // Filter to only sandbox-related pods
    const sandboxPods = pods.items
      .filter((pod: any) => 
        pod.metadata.namespace === 'agent-sandbox-system' ||
        pod.metadata.name.includes('sandbox')
      )
      .map((pod: any) => ({
        metadata: {
          name: pod.metadata.name,
          namespace: pod.metadata.namespace
        },
        status: {
          phase: pod.status.phase,
          podIP: pod.status.podIP,
          conditions: pod.status.conditions || []
        }
      }))

    return NextResponse.json({ 
      pods: { items: sandboxPods },
      message: 'Real telemetry fetched from container'
    })
  } catch (error: any) {
    console.error('Error fetching real telemetry:', error.message)
    
    // Fallback to mock data
    return NextResponse.json({
      pods: {
        items: [
          {
            metadata: { name: 'agent-sandbox-1', namespace: 'agent-sandbox-system' },
            status: {
              phase: 'Running',
              podIP: '10.42.0.2',
              conditions: [{ type: 'Ready', status: 'True' }]
            }
          },
          {
            metadata: { name: 'agent-sandbox-2', namespace: 'agent-sandbox-system' },
            status: {
              phase: 'Pending',
              podIP: null,
              conditions: [{ type: 'Ready', status: 'False' }]
            }
          }
        ]
      },
      message: `Using mock data (${error.message})`
    })
  }
}
