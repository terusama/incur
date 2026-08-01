import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { ToolAnnotations } from './Mcp.js'
import type { ToolCatalog } from './ToolCatalog.js'

export type ExecutionStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'error'
  | 'rejected'
  | 'rolled_back'
  | 'cancelled'

export type LogEntryState = 'pending' | 'executing' | 'applied' | 'reverted'
export type ReplayPolicy = 'log' | 'reexecute'

export type ToolPolicy = { requiresApproval: boolean; replay: ReplayPolicy }

export type ConnectorTool = {
  name: string
  description?: string | undefined
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown> | undefined
  instructions?: string | undefined
  annotations?: ToolAnnotations | undefined
  policy: ToolPolicy
}

export type ConnectorDescription = {
  name: string
  instructions?: string | undefined
  tools: ConnectorTool[]
}

export type ToolContext = {
  executionId: string
  request?: Request | undefined
  signal: AbortSignal
}

export interface Connector {
  describe(): ConnectorDescription | Promise<ConnectorDescription>
  execute(method: string, arguments_: unknown, context: ToolContext): unknown | Promise<unknown>
  revert?(
    method: string,
    arguments_: unknown,
    result: unknown,
    context: ToolContext,
  ): boolean | Promise<boolean>
  passEnded?(executionId: string, status: ExecutionStatus): void | Promise<void>
  executionEnded?(executionId: string, status: ExecutionStatus): void | Promise<void>
}

export type LogEntry = {
  seq: number
  connector: string
  method: string
  arguments: unknown
  result?: unknown
  requiresApproval: boolean
  ephemeral: boolean
  state: LogEntryState
}

export type PendingAction = {
  executionId: string
  seq: number
  connector: string
  method: string
  arguments: unknown
}

export type CapabilitySnapshot = {
  connectors: ConnectorDescription[]
  fingerprint: string
}

export const MAX_DURABLE_VALUE_BYTES = 1_000_000

export type ArtifactRef = {
  id: string
  executionId: string
  bytes: number
  preview: string
}

export interface ArtifactStore {
  put(executionId: string, value: unknown): Promise<ArtifactRef>
  get(executionId: string, artifactId: string): Promise<unknown | undefined>
  deleteExecution(executionId: string): Promise<void>
}

export class MemoryArtifactStore implements ArtifactStore {
  #values = new Map<string, { executionId: string; value: unknown }>()

  async put(executionId: string, value: unknown) {
    const serialized = JSON.stringify(value)
    const id = createHash('sha256').update(executionId).update(serialized).digest('hex')
    this.#values.set(id, { executionId, value: clone(value) })
    return artifactRef(id, executionId, serialized)
  }

  async get(executionId: string, artifactId: string) {
    const artifact = this.#values.get(artifactId)
    return artifact?.executionId === executionId ? clone(artifact.value) : undefined
  }

  async deleteExecution(executionId: string) {
    for (const [id, artifact] of this.#values)
      if (artifact.executionId === executionId) this.#values.delete(id)
  }
}

/** JSON-file artifact store with execution ownership checks. */
export class FileArtifactStore implements ArtifactStore {
  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  async put(executionId: string, value: unknown) {
    const serialized = JSON.stringify(value)
    const id = createHash('sha256').update(executionId).update(serialized).digest('hex')
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    await fs.writeFile(this.#file(id), JSON.stringify({ executionId, value }), { mode: 0o600 })
    return artifactRef(id, executionId, serialized)
  }

  async get(executionId: string, artifactId: string) {
    try {
      const stored = JSON.parse(await fs.readFile(this.#file(artifactId), 'utf8')) as {
        executionId: string
        value: unknown
      }
      return stored.executionId === executionId ? stored.value : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async deleteExecution(executionId: string) {
    try {
      for (const file of await fs.readdir(this.directory)) {
        if (!file.endsWith('.json')) continue
        const artifactId = file.slice(0, -5)
        if ((await this.get(executionId, artifactId)) !== undefined)
          await fs.unlink(this.#file(artifactId))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  #file(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid artifact id')
    return path.join(this.directory, `${id}.json`)
  }
}

export type ExecutionState = {
  id: string
  code: string
  status: ExecutionStatus
  log: LogEntry[]
  result?: unknown
  error?: string
  logs: string[]
  connectors: string[]
  capabilities: CapabilitySnapshot
  createdAt: number
  updatedAt: number
}

export interface RuntimeStore {
  get(id: string): Promise<ExecutionState | undefined>
  put(execution: ExecutionState): Promise<void>
}

export class MemoryRuntimeStore implements RuntimeStore {
  #executions = new Map<string, ExecutionState>()

  async get(id: string) {
    return clone(this.#executions.get(id))
  }

  async put(execution: ExecutionState) {
    this.#executions.set(execution.id, clone(execution)!)
  }
}

/** JSON-file runtime store for local agent processes. */
export class FileRuntimeStore implements RuntimeStore {
  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  async get(id: string) {
    try {
      return JSON.parse(await fs.readFile(this.#file(id), 'utf8')) as ExecutionState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async put(execution: ExecutionState) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = this.#file(execution.id)
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, JSON.stringify(execution, null, 2), { mode: 0o600 })
    await fs.rename(temporary, file)
  }

  #file(id: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid execution id')
    return path.join(this.directory, `${id}.json`)
  }
}

export type DispatchRequest = {
  seq: number
  connector: string
  method: string
  arguments?: unknown
}

export type DispatchResponse =
  | { result: unknown }
  | { __codemode_control__: 'pause' }
  | { __codemode_control__: 'error'; message: string }

export interface CodeExecutor {
  run(options: {
    code: string
    executionId: string
    connectors: ConnectorDescription[]
    dispatch(request: DispatchRequest): Promise<DispatchResponse>
    signal: AbortSignal
  }): Promise<{ result?: unknown; error?: string; logs: string[] }>
}

export class CatalogConnector implements Connector {
  readonly catalog: ToolCatalog
  readonly name: string
  readonly instructions?: string | undefined
  readonly resolvePolicy: (annotations: ToolAnnotations | undefined) => ToolPolicy

  constructor(
    catalog: ToolCatalog,
    options: {
      name?: string
      instructions?: string
      resolvePolicy?: (annotations: ToolAnnotations | undefined) => ToolPolicy
    } = {},
  ) {
    this.catalog = catalog
    this.name = options.name ?? sanitizeIdentifier(catalog.name)
    this.instructions = options.instructions ?? catalog.instructions
    this.resolvePolicy = options.resolvePolicy ?? defaultToolPolicy
    assertIdentifier(this.name)
  }

  describe(): ConnectorDescription {
    return {
      name: this.name,
      ...(this.instructions ? { instructions: this.instructions } : undefined),
      tools: this.catalog.list().map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : undefined),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : undefined),
        ...(tool.instructions ? { instructions: tool.instructions } : undefined),
        ...(tool.annotations ? { annotations: tool.annotations } : undefined),
        policy: this.resolvePolicy(tool.annotations),
      })),
    }
  }

  execute(method: string, arguments_: unknown, context: ToolContext) {
    return this.catalog.call(method, asRecord(arguments_), { request: context.request })
  }
}

/** Conservative policy: only explicitly local, closed-world, non-destructive reads skip approval. */
export function defaultToolPolicy(annotations: ToolAnnotations | undefined): ToolPolicy {
  const safeRead =
    annotations?.readOnlyHint === true &&
    annotations.destructiveHint !== true &&
    annotations.openWorldHint !== true
  return { requiresApproval: !safeRead, replay: safeRead ? 'reexecute' : 'log' }
}

export class CodeMode {
  #connectors = new Map<string, Connector>()
  #connectorList: Connector[]
  #executor: CodeExecutor
  #store: RuntimeStore
  #artifacts: ArtifactStore
  #controllers = new Map<string, AbortController>()

  constructor(options: {
    connectors: Connector[]
    executor: CodeExecutor
    store?: RuntimeStore
    artifacts?: ArtifactStore
  }) {
    this.#connectorList = options.connectors
    this.#executor = options.executor
    this.#store = options.store ?? new MemoryRuntimeStore()
    this.#artifacts = options.artifacts ?? new MemoryArtifactStore()
  }

  /** Searches current connector capabilities. */
  async search(query: string) {
    const connectors = await this.#descriptions()
    const normalized = normalize(query)
    const terms = normalized.split(' ').filter(Boolean)
    const results = connectors
      .flatMap((connector) =>
        connector.tools.map((tool) => {
          const target = `${connector.name}.${tool.name}`
          const haystack = normalize(`${target} ${tool.description ?? ''}`)
          let score = target === query ? 1_000 : 0
          for (const term of terms)
            if (haystack.includes(term)) score += target.includes(term) ? 10 : 2
          if (!normalized) score = 1
          return {
            path: target,
            connector: connector.name,
            method: tool.name,
            description: tool.description,
            types: generateTypes({ ...connector, tools: [tool] }),
            requiresApproval: tool.policy.requiresApproval,
            kind: 'method' as const,
            score,
          }
        }),
      )
      .filter((result) => !normalized || result.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    return { results: results.slice(0, 50), total: results.length, truncated: results.length > 50 }
  }

  /** Describes a connector or connector method. */
  async describe(target: string) {
    const connectors = await this.#descriptions()
    const connector = connectors.find((candidate) => candidate.name === target)
    if (connector)
      return {
        path: target,
        description: connector.instructions,
        requiresApproval: false,
        types: generateTypes(connector),
        kind: 'connector' as const,
      }
    const separator = target.indexOf('.')
    const connectorName = separator === -1 ? undefined : target.slice(0, separator)
    const method = separator === -1 ? target : target.slice(separator + 1)
    for (const candidate of connectors) {
      if (connectorName && candidate.name !== connectorName) continue
      const tool = candidate.tools.find((item) => item.name === method)
      if (tool)
        return {
          path: `${candidate.name}.${tool.name}`,
          description: tool.description,
          requiresApproval: tool.policy.requiresApproval,
          types: generateTypes({ ...candidate, tools: [tool] }),
          kind: 'method' as const,
        }
    }
    throw new Error(`Code Mode capability not found: ${target}`)
  }

  /** Starts and drives a new JavaScript execution. */
  async execute(code: string, options: { request?: Request; signal?: AbortSignal } = {}) {
    const descriptions = await this.#descriptions()
    const now = Date.now()
    const capabilities = snapshot(descriptions)
    const execution: ExecutionState = {
      id: executionId(),
      code,
      status: 'running',
      log: [],
      logs: [],
      connectors: descriptions.map((connector) => connector.name),
      capabilities,
      createdAt: now,
      updatedAt: now,
    }
    await this.#store.put(execution)
    return this.#drive(execution, options)
  }

  /** Returns durable state for one execution. */
  async execution(id: string) {
    const execution = await this.#store.get(id)
    if (!execution) throw new Error(`Code Mode execution not found: ${id}`)
    return execution
  }

  /** Loads one oversized value, scoped to its owning execution. */
  async artifact(executionId: string, artifactId: string) {
    return this.#artifacts.get(executionId, artifactId)
  }

  /** Returns the action currently waiting for approval. */
  async pending(id: string): Promise<PendingAction | undefined> {
    const execution = await this.execution(id)
    const entry = execution.log.find((item) => item.state === 'pending')
    return entry
      ? {
          executionId: id,
          seq: entry.seq,
          connector: entry.connector,
          method: entry.method,
          arguments: entry.arguments,
        }
      : undefined
  }

  /** Approves a pending action and resumes deterministic replay. */
  async approve(
    id: string,
    seq: number,
    options: { request?: Request; signal?: AbortSignal } = {},
  ) {
    const execution = await this.execution(id)
    this.#assertPaused(execution, seq)
    execution.log[seq]!.state = 'executing'
    execution.status = 'running'
    execution.updatedAt = Date.now()
    await this.#store.put(execution)
    return this.#drive(execution, options)
  }

  /** Rejects a pending action and terminates the execution. */
  async reject(id: string, seq: number) {
    const execution = await this.execution(id)
    this.#assertPaused(execution, seq)
    execution.log[seq]!.state = 'reverted'
    execution.status = 'rejected'
    execution.error = `Action ${seq} was rejected`
    execution.updatedAt = Date.now()
    await this.#store.put(execution)
    await this.#end(execution)
    return execution
  }

  /** Cancels a running or paused execution. */
  async cancel(id: string) {
    const execution = await this.execution(id)
    if (terminal(execution.status)) return execution
    this.#controllers.get(id)?.abort()
    execution.status = 'cancelled'
    execution.error = 'Execution cancelled'
    execution.updatedAt = Date.now()
    await this.#store.put(execution)
    await this.#end(execution)
    return execution
  }

  /** Calls connector compensation hooks in reverse applied order. */
  async rollback(id: string) {
    const execution = await this.execution(id)
    const controller = new AbortController()
    for (const entry of [...execution.log].reverse()) {
      if (entry.state !== 'applied') continue
      const connector = this.#connectors.get(entry.connector)
      if (!connector?.revert) continue
      const reverted = await connector.revert(
        entry.method,
        entry.arguments,
        await this.#materialize(id, entry.result),
        {
          executionId: id,
          signal: controller.signal,
        },
      )
      if (reverted) entry.state = 'reverted'
    }
    execution.status = 'rolled_back'
    execution.updatedAt = Date.now()
    await this.#store.put(execution)
    await this.#end(execution)
    return execution
  }

  async #drive(
    execution: ExecutionState,
    options: { request?: Request; signal?: AbortSignal } = {},
  ) {
    if (terminal(execution.status)) return execution
    const controller = new AbortController()
    this.#controllers.set(execution.id, controller)
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true })
    const descriptions = execution.capabilities.connectors
    try {
      const output = await this.#executor.run({
        code: execution.code,
        executionId: execution.id,
        connectors: descriptions,
        signal: controller.signal,
        dispatch: (request) =>
          this.#dispatch(execution, request, controller.signal, options.request),
      })
      execution.logs = output.logs
      if (execution.status === 'paused') {
        execution.updatedAt = Date.now()
      } else if (controller.signal.aborted) {
        execution.status = 'cancelled'
        execution.error = 'Execution cancelled'
      } else if (output.error) {
        execution.status = 'error'
        execution.error = output.error
      } else {
        execution.status = 'completed'
        execution.result = await this.#durable(execution.id, output.result)
        delete execution.error
      }
    } catch (error) {
      if (controller.signal.aborted) {
        execution.status = 'cancelled'
        execution.error = 'Execution cancelled'
      } else {
        execution.status = 'error'
        execution.error = error instanceof Error ? error.message : String(error)
      }
    } finally {
      execution.updatedAt = Date.now()
      await this.#store.put(execution)
      options.signal?.removeEventListener('abort', abort)
      this.#controllers.delete(execution.id)
      for (const connector of this.#connectors.values())
        await connector.passEnded?.(execution.id, execution.status)
      if (terminal(execution.status)) await this.#end(execution)
    }
    return execution
  }

  async #dispatch(
    execution: ExecutionState,
    request: DispatchRequest,
    signal: AbortSignal,
    inboundRequest?: Request,
  ): Promise<DispatchResponse> {
    if (signal.aborted) return { __codemode_control__: 'error', message: 'Execution cancelled' }
    if (request.connector === 'codemode') {
      try {
        if (request.method === 'search')
          return { result: await this.search(String(asRecord(request.arguments).query ?? '')) }
        if (request.method === 'describe')
          return { result: await this.describe(String(asRecord(request.arguments).target ?? '')) }
        return {
          __codemode_control__: 'error',
          message: `Unknown codemode method: ${request.method}`,
        }
      } catch (error) {
        return {
          __codemode_control__: 'error',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const connectorDescription = execution.capabilities.connectors.find(
      (connector) => connector.name === request.connector,
    )
    const tool = connectorDescription?.tools.find((candidate) => candidate.name === request.method)
    const connector = this.#connectors.get(request.connector)
    if (!tool || !connector)
      return {
        __codemode_control__: 'error',
        message: `Tool not found: ${request.connector}.${request.method}`,
      }
    const existing = execution.log.find((entry) => entry.seq === request.seq)
    if (existing) {
      if (
        existing.connector !== request.connector ||
        existing.method !== request.method ||
        stableJson(existing.arguments) !== stableJson(request.arguments ?? {})
      )
        return {
          __codemode_control__: 'error',
          message: `Replay diverged at action ${request.seq}`,
        }
      if (existing.state === 'pending') return { __codemode_control__: 'pause' }
      if (existing.state === 'reverted')
        return {
          __codemode_control__: 'error',
          message: `Action ${request.seq} is no longer executable`,
        }
      if (existing.state === 'applied' && !existing.ephemeral)
        return { result: await this.#materialize(execution.id, existing.result) }
      return this.#apply(execution, existing, connector, signal, inboundRequest)
    }
    if (request.seq !== execution.log.length)
      return { __codemode_control__: 'error', message: `Unexpected action sequence ${request.seq}` }
    const entry: LogEntry = {
      seq: request.seq,
      connector: request.connector,
      method: request.method,
      arguments: request.arguments ?? {},
      requiresApproval: tool.policy.requiresApproval,
      ephemeral: tool.policy.replay === 'reexecute',
      state: tool.policy.requiresApproval ? 'pending' : 'executing',
    }
    execution.log.push(entry)
    if (entry.state === 'pending') {
      execution.status = 'paused'
      execution.updatedAt = Date.now()
      await this.#store.put(execution)
      return { __codemode_control__: 'pause' }
    }
    return this.#apply(execution, entry, connector, signal, inboundRequest)
  }

  async #apply(
    execution: ExecutionState,
    entry: LogEntry,
    connector: Connector,
    signal: AbortSignal,
    request?: Request,
  ): Promise<DispatchResponse> {
    entry.state = 'executing'
    await this.#store.put(execution)
    try {
      const result = await connector.execute(entry.method, entry.arguments, {
        executionId: execution.id,
        request,
        signal,
      })
      entry.result = await this.#durable(execution.id, result)
      entry.state = 'applied'
      execution.updatedAt = Date.now()
      await this.#store.put(execution)
      return { result }
    } catch (error) {
      entry.state = 'reverted'
      const message = error instanceof Error ? error.message : String(error)
      return { __codemode_control__: 'error', message }
    }
  }

  async #descriptions() {
    const descriptions: ConnectorDescription[] = []
    this.#connectors.clear()
    for (const connector of this.#connectorList) {
      const description = await connector.describe()
      assertIdentifier(description.name)
      if (this.#connectors.has(description.name))
        throw new Error(`Duplicate Code Mode connector name: ${description.name}`)
      this.#connectors.set(description.name, connector)
      descriptions.push(description)
    }
    return descriptions.sort((a, b) => a.name.localeCompare(b.name))
  }

  #assertPaused(execution: ExecutionState, seq: number) {
    if (execution.status !== 'paused' || execution.log[seq]?.state !== 'pending')
      throw new Error(`Action ${seq} is not pending approval`)
  }

  async #end(execution: ExecutionState) {
    for (const connector of this.#connectors.values())
      await connector.executionEnded?.(execution.id, execution.status)
  }

  async #durable(executionId: string, value: unknown) {
    const serialized = JSON.stringify(value)
    if (Buffer.byteLength(serialized) <= MAX_DURABLE_VALUE_BYTES) return value
    return { $artifact: await this.#artifacts.put(executionId, value) }
  }

  async #materialize(executionId: string, value: unknown) {
    const reference = asRecord(value).$artifact as ArtifactRef | undefined
    if (!reference?.id) return value
    const artifact = await this.#artifacts.get(executionId, reference.id)
    if (artifact === undefined) throw new Error(`Artifact not found: ${reference.id}`)
    return artifact
  }
}

export function generateTypes(connector: ConnectorDescription) {
  const methods = connector.tools
    .map((tool) => {
      const description = tool.description
        ? `  /** ${tool.description.replaceAll('*/', '*\\/')} */\n`
        : ''
      return `${description}  ${JSON.stringify(tool.name)}(args?: ${schemaType(tool.inputSchema)}): Promise<${schemaType(tool.outputSchema)}>;`
    })
    .join('\n')
  return `declare const ${connector.name}: {\n${methods}\n};`
}

function schemaType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'unknown'
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.map((value) => schemaType(asRecord(value))).join(' | ')
  if (schema.type === 'array') return `Array<${schemaType(asRecord(schema.items))}>`
  if (schema.type === 'object' || schema.properties) {
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
    return `{ ${Object.entries(asRecord(schema.properties))
      .map(
        ([key, value]) =>
          `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${schemaType(asRecord(value))}`,
      )
      .join('; ')} }`
  }
  if (schema.type === 'string') return 'string'
  if (schema.type === 'number' || schema.type === 'integer') return 'number'
  if (schema.type === 'boolean') return 'boolean'
  if (schema.type === 'null') return 'null'
  return 'unknown'
}

function snapshot(connectors: ConnectorDescription[]): CapabilitySnapshot {
  const copy = clone(connectors)!
  return {
    connectors: copy,
    fingerprint: createHash('sha256').update(stableJson(copy)).digest('hex'),
  }
}

function executionId() {
  return `${Date.now().toString(36)}-${randomUUID()}`
}

function terminal(status: ExecutionStatus) {
  return ['completed', 'error', 'rejected', 'rolled_back', 'cancelled'].includes(status)
}

function sanitizeIdentifier(value: string) {
  const result = value.replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^[^A-Za-z_$]/, '_')
  return result || 'tools'
}

function assertIdentifier(value: string) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) || ['codemode', 'console', 'fetch'].includes(value))
    throw new Error(`Invalid or reserved Code Mode connector name: ${value}`)
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function stableJson(value: unknown) {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortValue(child)]),
    )
  return value
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

function artifactRef(id: string, executionId: string, serialized: string): ArtifactRef {
  return {
    id,
    executionId,
    bytes: Buffer.byteLength(serialized),
    preview: serialized.slice(0, 512),
  }
}
