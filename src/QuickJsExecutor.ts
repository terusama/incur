import { getQuickJS } from 'quickjs-emscripten'

import type {
  CodeExecutor,
  ConnectorDescription,
  DispatchRequest,
  DispatchResponse,
} from './CodeMode.js'

export type Options = {
  timeoutMs?: number
  memoryLimitBytes?: number
  maxStackBytes?: number
}

/** Resource-bounded QuickJS WASM executor with one serialized host dispatch bridge. */
export class QuickJsExecutor implements CodeExecutor {
  readonly timeoutMs: number
  readonly memoryLimitBytes: number
  readonly maxStackBytes: number

  constructor(options: Options = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.memoryLimitBytes = options.memoryLimitBytes ?? 64 * 1024 * 1024
    this.maxStackBytes = options.maxStackBytes ?? 512 * 1024
  }

  async run(options: {
    code: string
    executionId: string
    connectors: ConnectorDescription[]
    dispatch(request: DispatchRequest): Promise<DispatchResponse>
    signal: AbortSignal
  }) {
    const quickjs = await getQuickJS()
    const context = quickjs.newContext()
    const deadline = Date.now() + this.timeoutMs
    context.runtime.setMemoryLimit(this.memoryLimitBytes)
    context.runtime.setMaxStackSize(this.maxStackBytes)
    context.runtime.setInterruptHandler(() => options.signal.aborted || Date.now() >= deadline)

    let dispatch = Promise.resolve()
    const dispatchHandle = context.newFunction('__hostDispatch', (requestHandle) => {
      const input = context.getString(requestHandle)
      const deferred = context.newPromise()
      const next = dispatch.then(() => options.dispatch(JSON.parse(input) as DispatchRequest))
      dispatch = next.then(
        () => undefined,
        () => undefined,
      )
      void next.then(
        (response) => {
          context.newString(JSON.stringify(response)).consume(deferred.resolve)
          context.runtime.executePendingJobs()
          if (deferred.handle.alive) deferred.handle.dispose()
        },
        (error) => {
          context
            .newString(
              JSON.stringify({
                __codemode_control__: 'error',
                message: error instanceof Error ? error.message : String(error),
              }),
            )
            .consume(deferred.resolve)
          context.runtime.executePendingJobs()
          if (deferred.handle.alive) deferred.handle.dispose()
        },
      )
      return deferred.handle
    })
    dispatchHandle.consume((handle) => context.setProp(context.global, '__hostDispatch', handle))

    try {
      const evaluated = context.evalCode(
        buildProgram(options.code, options.executionId, options.connectors),
        'codemode.js',
      )
      if (evaluated.error) {
        const error = context.dump(evaluated.error)
        if (evaluated.error.alive) evaluated.error.dispose()
        return { error: error instanceof Error ? error.message : String(error), logs: [] }
      }
      const settling = context.resolvePromise(evaluated.value)
      // Async function bodies are QuickJS jobs. Each settled host promise drains the next job.
      context.runtime.executePendingJobs()
      const resolved = await settling
      if (evaluated.value.alive) evaluated.value.dispose()
      if (resolved.error) {
        const error = context.dump(resolved.error)
        if (resolved.error.alive) resolved.error.dispose()
        return { error: quickJsError(error), logs: [] }
      }
      const output = context.dump(resolved.value) as {
        result?: unknown
        error?: string | null
        logs?: string[]
      }
      if (resolved.value.alive) resolved.value.dispose()
      return {
        ...(output.error ? { error: output.error } : { result: output.result }),
        logs: output.logs ?? [],
      }
    } finally {
      context.dispose()
    }
  }
}

function quickJsError(value: unknown) {
  if (value && typeof value === 'object' && 'message' in value) return String(value.message)
  return String(value)
}

function buildProgram(code: string, executionId: string, connectors: ConnectorDescription[]) {
  const bindings = connectors
    .map((connector) => {
      const methods = connector.tools
        .map(
          (tool) =>
            `${JSON.stringify(tool.name)}: async (args = {}) => __unwrap(JSON.parse(await __hostDispatch(JSON.stringify({ seq: __seq++, connector: ${JSON.stringify(connector.name)}, method: ${JSON.stringify(tool.name)}, arguments: __encode(args) }))))`,
        )
        .join(',\n')
      return `const ${connector.name} = { ${methods} };`
    })
    .join('\n')
  const program = normalizeCode(code)
  return `
const __logs = [];
let __seq = 0;
const console = {
  log: (...values) => __logs.push(values.map(String).join(' ')),
  info: (...values) => __logs.push(values.map(String).join(' ')),
  warn: (...values) => __logs.push(values.map(String).join(' ')),
  error: (...values) => __logs.push(values.map(String).join(' '))
};
const __encode = (value) => {
  if (value === undefined) return { __codemode_type: 'undefined' };
  if (typeof value === 'bigint') return { __codemode_type: 'bigint', value: value.toString() };
  if (Array.isArray(value)) return value.map(__encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, __encode(child)]));
  return value;
};
const __decode = (value) => {
  if (Array.isArray(value)) return value.map(__decode);
  if (value && typeof value === 'object') {
    if (value.__codemode_type === 'undefined') return undefined;
    if (value.__codemode_type === 'bigint') return BigInt(value.value);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, __decode(child)]));
  }
  return value;
};
const __unwrap = (response) => {
  if (response.__codemode_control__ === 'pause') throw new Error('__CODEMODE_PAUSE__');
  if (response.__codemode_control__ === 'error') throw new Error(response.message);
  return __decode(response.result);
};
${bindings}
const __callBuiltin = async (method, args) => __unwrap(JSON.parse(await __hostDispatch(JSON.stringify({ seq: __seq++, connector: 'codemode', method, arguments: __encode(args) }))));
const codemode = {
  executionId: ${JSON.stringify(executionId)},
  search: (query) => __callBuiltin('search', { query }),
  describe: (target) => __callBuiltin('describe', { target })
};
(async () => {
  try {
    const __program = (${program});
    const result = await __program();
    return { result: __encode(result), error: null, logs: __logs };
  } catch (error) {
    return { result: null, error: error instanceof Error ? error.message : String(error), logs: __logs };
  }
})()
`
}

function normalizeCode(code: string) {
  const trimmed = code.trim()
  if (/^(async\s*)?\([^)]*\)\s*=>/.test(trimmed) || /^async\s+function/.test(trimmed))
    return trimmed
  return `async () => {\n${trimmed}\n}`
}
