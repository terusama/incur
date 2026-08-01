import { Cli, middleware, ToolCatalog, z } from 'incur'

describe('ToolCatalog', () => {
  test('lists, searches, filters, and calls commands', async () => {
    const cli = Cli.create('catalog-test', {
      env: z.object({ CATALOG_TOKEN: z.string() }),
      vars: z.object({ prefix: z.string().default('') }),
      version: '1.2.3',
    })
    cli.use(
      middleware<typeof cli.vars, typeof cli.env>(async (context, next) => {
        context.var.prefix = `${context.env.CATALOG_TOKEN}:`
        return next()
      }),
    )
    cli.command('read-user', {
      description: 'Read a user profile',
      args: z.object({ id: z.string() }),
      mcp: { annotations: { readOnlyHint: true, openWorldHint: false } },
      output: z.object({ value: z.string() }),
      run: (context) => ({ value: `${context.var.prefix}${context.args.id}` }),
    })
    cli.command('hidden', { mcp: false, run: () => 'nope' })

    process.env.CATALOG_TOKEN = 'secret'
    const catalog = await cli.toolCatalog()

    expect(catalog.name).toBe('catalog-test')
    expect(catalog.version).toBe('1.2.3')
    expect(catalog.list().map((tool) => tool.name)).toEqual(['read-user'])
    expect(catalog.search('profile').map((tool) => tool.name)).toEqual(['read-user'])
    await expect(catalog.call('read-user', { id: '42' })).resolves.toEqual({ value: 'secret:42' })
    await expect(catalog.call('missing')).rejects.toThrow('Tool not found: missing')
  })

  test('returns strings from unstructured command output and surfaces command errors', async () => {
    const cli = Cli.create('catalog-test')
    cli.command('text', { run: () => 'hello' })
    cli.command('fail', {
      run: (context) => context.error({ code: 'FAILED', message: 'expected failure' }),
    })
    const catalog = await cli.toolCatalog()

    await expect(catalog.call('text')).resolves.toBe('hello')
    await expect(catalog.call('fail')).rejects.toBeInstanceOf(ToolCatalog.ToolCallError)
    await expect(catalog.call('fail')).rejects.toThrow('expected failure')
  })

  test('waits for asynchronously generated command sources', async () => {
    const cli = Cli.create('catalog-test')
    cli.command('remote', {
      fetch: async () => new Response('{}'),
      openapi: {
        openapi: '3.1.0',
        info: { title: 'Remote', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'listUsers',
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
    })

    const catalog = await cli.toolCatalog()
    expect(catalog.list().some((tool) => tool.name.includes('listUsers'))).toBe(true)
  })
})
