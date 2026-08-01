import { Cli, CodeMode, QuickJsExecutor, z } from 'incur'

async function createRuntime() {
  const calls: string[] = []
  const cli = Cli.create('work')
  cli.command('read', {
    args: z.object({ id: z.string() }),
    mcp: { annotations: { readOnlyHint: true, openWorldHint: false } },
    output: z.object({ id: z.string(), count: z.number() }),
    run: ({ args }) => {
      calls.push(`read:${args.id}`)
      return { id: args.id, count: calls.length }
    },
  })
  cli.command('write', {
    args: z.object({ value: z.string() }),
    mcp: { annotations: { readOnlyHint: false, openWorldHint: false } },
    output: z.object({ saved: z.string() }),
    run: ({ args }) => {
      calls.push(`write:${args.value}`)
      return { saved: args.value }
    },
  })
  const connector = new CodeMode.CatalogConnector(await cli.toolCatalog())
  const runtime = new CodeMode.CodeMode({
    connectors: [connector],
    executor: new QuickJsExecutor.QuickJsExecutor({ timeoutMs: 2_000 }),
  })
  return { calls, runtime }
}

describe('CodeMode', () => {
  test('executes composed safe reads in QuickJS', async () => {
    const { calls, runtime } = await createRuntime()
    const execution = await runtime.execute(`
      const first = await work.read({ id: 'a' });
      const second = await work.read({ id: 'b' });
      console.log(first.id, second.id);
      return [first.id, second.id];
    `)

    expect(execution.status).toBe('completed')
    expect(execution.result).toEqual(['a', 'b'])
    expect(execution.logs).toEqual(['a b'])
    expect(calls).toEqual(['read:a', 'read:b'])
  })

  test('pauses writes, then approves and deterministically replays', async () => {
    const { calls, runtime } = await createRuntime()
    const paused = await runtime.execute(`
      const before = await work.read({ id: 'a' });
      const saved = await work.write({ value: before.id });
      return saved;
    `)

    expect(paused.status).toBe('paused')
    expect(await runtime.pending(paused.id)).toMatchObject({
      seq: 1,
      connector: 'work',
      method: 'write',
      arguments: { value: 'a' },
    })
    expect(calls).toEqual(['read:a'])

    const completed = await runtime.approve(paused.id, 1)
    expect(completed.status).toBe('completed')
    expect(completed.result).toEqual({ saved: 'a' })
    expect(calls).toEqual(['read:a', 'read:a', 'write:a'])
    expect(completed.log.map((entry) => entry.state)).toEqual(['applied', 'applied'])
  })

  test('rejects and cancels executions', async () => {
    const { runtime } = await createRuntime()
    const paused = await runtime.execute(`return work.write({ value: 'no' });`)
    expect((await runtime.reject(paused.id, 0)).status).toBe('rejected')

    const cancelled = await runtime.cancel(
      (await runtime.execute(`return work.write({ value: 'later' });`)).id,
    )
    expect(cancelled.status).toBe('cancelled')
  })

  test('searches and describes model-facing capabilities', async () => {
    const { runtime } = await createRuntime()
    const search = await runtime.search('read')
    expect(search.results[0]).toMatchObject({ path: 'work.read', requiresApproval: false })
    await expect(runtime.describe('work.write')).resolves.toMatchObject({
      path: 'work.write',
      requiresApproval: true,
    })
  })

  test('bounds runaway JavaScript', async () => {
    const cli = Cli.create('work')
    const runtime = new CodeMode.CodeMode({
      connectors: [new CodeMode.CatalogConnector(await cli.toolCatalog())],
      executor: new QuickJsExecutor.QuickJsExecutor({ timeoutMs: 20 }),
    })
    const execution = await runtime.execute('while (true) {}')
    expect(execution.status).toBe('error')
    expect(execution.error).toBeTruthy()
  })

  test('supports generic connectors and spills oversized results to owned artifacts', async () => {
    const artifacts = new CodeMode.MemoryArtifactStore()
    const runtime = new CodeMode.CodeMode({
      connectors: [
        {
          describe: () => ({ name: 'generic', tools: [] }),
          execute: () => undefined,
        },
      ],
      artifacts,
      executor: {
        run: async () => ({ result: 'x'.repeat(CodeMode.MAX_DURABLE_VALUE_BYTES + 1), logs: [] }),
      },
    })

    const execution = await runtime.execute('return null')
    const reference = (execution.result as any).$artifact as CodeMode.ArtifactRef
    expect(reference.bytes).toBeGreaterThan(CodeMode.MAX_DURABLE_VALUE_BYTES)
    await expect(runtime.artifact(execution.id, reference.id)).resolves.toHaveLength(
      CodeMode.MAX_DURABLE_VALUE_BYTES + 1,
    )
    await expect(runtime.artifact('another-execution', reference.id)).resolves.toBeUndefined()
  })
})
