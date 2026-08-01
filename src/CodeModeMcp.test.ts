import { Cli, CodeMode, CodeModeMcp, Mcp, QuickJsExecutor } from 'incur'
import { PassThrough } from 'node:stream'

describe('CodeModeMcp', () => {
  test('exposes exactly five stable lifecycle tools', async () => {
    const cli = Cli.create('work')
    const service = new CodeMode.CodeMode({
      connectors: [new CodeMode.CatalogConnector(await cli.toolCatalog())],
      executor: new QuickJsExecutor.QuickJsExecutor(),
    })
    expect(Mcp.collectTools(CodeModeMcp.commands(service), []).map((tool) => tool.name)).toEqual(
      [...CodeModeMcp.toolNames].sort(),
    )
  })

  test('serves search and execution over stdio MCP', async () => {
    const cli = Cli.create('work')
    const service = new CodeMode.CodeMode({
      connectors: [new CodeMode.CatalogConnector(await cli.toolCatalog())],
      executor: new QuickJsExecutor.QuickJsExecutor(),
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk) => chunks.push(chunk.toString()))
    const done = CodeModeMcp.serve(service, { input, output, version: '1.0.0' })
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`,
    )
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
    const started = Date.now()
    while (chunks.length < 2 && Date.now() - started < 1_000)
      await new Promise((resolve) => setTimeout(resolve, 5))
    input.end()
    await done
    const response = chunks.map((chunk) => JSON.parse(chunk.trim())).find((item) => item.id === 2)
    expect(response.result.tools.map((tool: any) => tool.name)).toEqual(
      [...CodeModeMcp.toolNames].sort(),
    )
  })
})
