import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'

import type { CodeMode } from './CodeMode.js'
import * as Mcp from './Mcp.js'

export const toolNames = [
  'codemode_search',
  'codemode_execute',
  'codemode_execution',
  'codemode_decide',
  'codemode_cancel',
] as const

/** Serves the stable five-tool Code Mode lifecycle over MCP stdio. */
export async function serve(service: CodeMode, options: Options = {}) {
  return Mcp.serve(
    options.name ?? 'incur-codemode',
    options.version ?? '0.0.0',
    commands(service),
    {
      input: options.input,
      instructions:
        options.instructions ??
        'Search available methods, execute JavaScript, then inspect, decide, or cancel by execution ID.',
      output: options.output,
      tools: { discovery: 'direct' },
    },
  )
}

export type Options = {
  name?: string
  version?: string
  instructions?: string
  input?: Readable
  output?: Writable
}

/** @internal Creates the lifecycle command graph used by the MCP transport. */
export function commands(service: CodeMode) {
  return new Map<string, any>([
    [
      'codemode_search',
      {
        description: 'Search available Code Mode methods and saved snippets.',
        options: z.object({ query: z.string() }),
        mcp: { annotations: { readOnlyHint: true, openWorldHint: false } },
        run: ({ options }: any) => service.search(options.query),
      },
    ],
    [
      'codemode_execute',
      {
        description: 'Start durable JavaScript execution and return its current state.',
        options: z.object({ code: z.string() }),
        mcp: { annotations: { readOnlyHint: false, openWorldHint: true } },
        run: ({ options }: any) => service.execute(options.code),
      },
    ],
    [
      'codemode_execution',
      {
        description: 'Read an execution or one oversized artifact owned by it.',
        options: z.object({ id: z.string(), artifact_id: z.string().optional() }),
        mcp: { annotations: { readOnlyHint: true, openWorldHint: false } },
        async run({ options, error }: any) {
          if (!options.artifact_id) return service.execution(options.id)
          const artifact = await service.artifact(options.id, options.artifact_id)
          if (artifact === undefined)
            return error({ code: 'ARTIFACT_NOT_FOUND', message: 'Code Mode artifact not found' })
          return artifact
        },
      },
    ],
    [
      'codemode_decide',
      {
        description: 'Approve or reject one pending Code Mode action.',
        options: z.object({
          id: z.string(),
          seq: z.number().int().nonnegative(),
          decision: z.enum(['approve', 'reject']),
        }),
        mcp: { annotations: { readOnlyHint: false, openWorldHint: true } },
        run: ({ options }: any) =>
          options.decision === 'approve'
            ? service.approve(options.id, options.seq)
            : service.reject(options.id, options.seq),
      },
    ],
    [
      'codemode_cancel',
      {
        description: 'Cancel one running or paused Code Mode execution.',
        options: z.object({ id: z.string() }),
        mcp: { annotations: { readOnlyHint: false, openWorldHint: false } },
        run: ({ options }: any) => service.cancel(options.id),
      },
    ],
  ])
}
