#!/usr/bin/env node

const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const scenarioDirectory = join(__dirname, 'fake-agent-scenarios')

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function loadScenario() {
  const explicitFile = argumentValue('--scenario-file')
  const name = argumentValue('--scenario') ?? 'success'
  const file =
    explicitFile === undefined ? join(scenarioDirectory, `${name}.json`) : resolve(explicitFile)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeHandoff(value) {
  const handoffPath = process.env.TESKRA_HANDOFF_PATH
  if (handoffPath === undefined || handoffPath.length === 0) return
  mkdirSync(dirname(handoffPath), { recursive: true })
  writeFileSync(handoffPath, value, 'utf8')
}

async function writeOutput(bytes) {
  const chunk = Buffer.alloc(64 * 1024, 'x')
  let remaining = bytes
  while (remaining > 0) {
    const next = chunk.subarray(0, Math.min(chunk.length, remaining))
    remaining -= next.length
    if (!process.stdout.write(next)) {
      await new Promise((resolveDrain) => process.stdout.once('drain', resolveDrain))
    }
  }
}

async function waitForInput(scenario) {
  process.stdout.write(`${scenario.prompt}\n`)
  process.stdin.setEncoding('utf8')
  for await (const input of process.stdin) {
    process.stdout.write(`${scenario.responsePrefix}${input.trim()}\n`)
    return
  }
}

async function main() {
  if (process.argv.includes('--version')) {
    process.stdout.write('teskra-fake-agent 1.0.0\n')
    return
  }

  let scenario
  try {
    scenario = loadScenario()
  } catch (error) {
    console.error(`Fake Agent scenario could not be loaded: ${error.message}`)
    process.exitCode = 2
    return
  }

  for (const line of scenario.stdout ?? []) process.stdout.write(`${line}\n`)
  for (const line of scenario.stderr ?? []) process.stderr.write(`${line}\n`)

  if (scenario.outputBytes !== undefined) await writeOutput(scenario.outputBytes)
  if (scenario.waitForInput === true) await waitForInput(scenario)
  if (scenario.writeFile !== undefined) {
    writeFileSync(resolve(process.cwd(), scenario.writeFile), scenario.writeContents ?? '', 'utf8')
  }
  if (scenario.handoff !== undefined) {
    writeHandoff(
      JSON.stringify(
        { runId: process.env.TESKRA_RUN_ID ?? 'fake-run', ...scenario.handoff },
        null,
        2,
      ),
    )
  }
  if (scenario.rawHandoff !== undefined) writeHandoff(scenario.rawHandoff)
  if (scenario.hang === true) await new Promise(() => setInterval(() => {}, 60_000))

  process.exitCode = scenario.exitCode ?? 0
}

void main()
