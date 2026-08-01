import type { z } from 'zod'

import type * as Mcp from './Mcp.js'
import * as McpRuntime from './Mcp.js'
import type { Handler as MiddlewareHandler } from './middleware.js'

/** A transport-neutral tool definition derived from an Incur command. */
export type ToolDefinition = {
  name: string
  description?: string | undefined
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  outputSchema?: Record<string, unknown> | undefined
  annotations?: Mcp.ToolAnnotations | undefined
  instructions?: string | undefined
}

/** Per-call context supplied by a catalog consumer. */
export type CallContext = {
  /** Inbound request propagated to command middleware and handlers. */
  request?: Request | undefined
}

/** Options used to construct a tool catalog. */
export type Options = {
  /** Tool name patterns to expose. Discovery mode is ignored. */
  tools?: Mcp.ToolFilter | undefined
}

/** A command catalog that can be discovered and invoked without an MCP transport. */
export class ToolCatalog {
  readonly name: string
  readonly version: string
  readonly instructions?: string | undefined

  #entries: ReadonlyMap<string, Mcp.ToolEntry>
  #options: InternalOptions

  /** @internal Construct catalogs through `Cli.toolCatalog()`. */
  constructor(entries: Mcp.ToolEntry[], options: InternalOptions) {
    this.name = options.name
    this.version = options.version
    this.instructions = options.instructions
    this.#entries = new Map(entries.map((entry) => [entry.name, entry]))
    this.#options = options
  }

  /** Returns every tool definition in stable name order. */
  list(): ToolDefinition[] {
    return [...this.#entries.values()].map(toDefinition)
  }

  /** Returns one tool definition, or undefined when it is not exposed. */
  get(name: string): ToolDefinition | undefined {
    const entry = this.#entries.get(name)
    return entry ? toDefinition(entry) : undefined
  }

  /** Searches names and descriptions using the same deterministic ranking as MCP discovery. */
  search(query: string, options: { limit?: number; offset?: number } = {}): ToolDefinition[] {
    const normalized = normalizeSearch(query)
    const terms = normalized.split(' ').filter(Boolean)
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.max(0, options.limit ?? 20)
    return [...this.#entries.values()]
      .map((entry) => ({ entry, score: score(entry, normalized, terms) }))
      .filter(({ score }) => query.trim() === '' || score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(offset, offset + limit)
      .map(({ entry }) => toDefinition(entry))
  }

  /** Invokes an exposed command with agent-mode parsing and the CLI middleware chain. */
  async call(
    name: string,
    input: Record<string, unknown> = {},
    context: CallContext = {},
  ): Promise<unknown> {
    const entry = this.#entries.get(name)
    if (!entry) throw new Error(`Tool not found: ${name}`)
    const result = await McpRuntime.callTool(entry, input, {
      env: this.#options.env,
      middlewares: this.#options.middlewares,
      name: this.name,
      request: context.request,
      vars: this.#options.vars,
      version: this.version,
    })
    if (result.isError) throw new ToolCallError(name, result.content[0]?.text ?? 'Tool call failed')
    if (result.structuredContent !== undefined) return result.structuredContent
    const text = result.content[0]?.text
    if (text === undefined || text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

/** Error thrown when an Incur command returns an error result. */
export class ToolCallError extends Error {
  readonly tool: string

  constructor(tool: string, message: string) {
    super(message)
    this.name = 'ToolCallError'
    this.tool = tool
  }
}

/** @internal Options supplied by `Cli.create()`. */
export type InternalOptions = {
  name: string
  version: string
  instructions?: string | undefined
  env?: z.ZodObject<any> | undefined
  middlewares?: MiddlewareHandler[] | undefined
  vars?: z.ZodObject<any> | undefined
}

function toDefinition(entry: Mcp.ToolEntry): ToolDefinition {
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : undefined),
    inputSchema: entry.inputSchema,
    ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : undefined),
    ...(entry.annotations ? { annotations: entry.annotations } : undefined),
    ...(entry.instructions ? { instructions: entry.instructions } : undefined),
  }
}

function score(entry: Mcp.ToolEntry, query: string, terms: string[]) {
  if (!query) return 1
  const name = normalizeSearch(entry.name)
  const description = normalizeSearch(entry.description ?? '')
  if (name === query) return 1_000
  let value = name.startsWith(query) ? 100 : name.includes(query) ? 50 : 0
  for (const term of terms) {
    if (name.split(' ').includes(term)) value += 20
    else if (name.includes(term)) value += 10
    if (description.includes(term)) value += 2
  }
  return value
}

function normalizeSearch(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
