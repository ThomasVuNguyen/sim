#!/usr/bin/env node

import { execSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import chalk from 'chalk'
import { Command } from 'commander'

const NETWORK_NAME = 'simstudio-network'
const DB_CONTAINER = 'simstudio-db'
const MIGRATIONS_CONTAINER = 'simstudio-migrations'
const REALTIME_CONTAINER = 'simstudio-realtime'
const APP_CONTAINER = 'simstudio-app'
const DEFAULT_PORT = '2222'
const CONFIG_DIR = join(homedir(), '.simstudio')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const DATA_DIR = join(CONFIG_DIR, 'data')

interface Config {
	port: string
	betterAuthSecret: string
	encryptionKey: string
	internalApiSecret: string
	apiEncryptionKey: string
	disableAuth: boolean
	createdAt: string
}

/**
 * Generate a secure random secret
 */
function generateSecret(): string {
	return randomBytes(32).toString('hex')
}

/**
 * Load or create configuration
 */
function loadConfig(port?: string): Config {
	// Ensure config directory exists
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true })
	}

	// Load existing config or create new one
	let config: Config

	if (existsSync(CONFIG_FILE)) {
		try {
			const data = readFileSync(CONFIG_FILE, 'utf-8')
			config = JSON.parse(data)

			// Update port if provided
			if (port) {
				config.port = port
			}
		} catch (error) {
			console.log(chalk.yellow('⚠️  Invalid config file, creating new one...'))
			config = createNewConfig(port)
		}
	} else {
		console.log(chalk.blue('🔐 Generating secure secrets for first-time setup...'))
		config = createNewConfig(port)
	}

	// Save config
	writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))

	return config
}

/**
 * Create new configuration with auto-generated secrets
 */
function createNewConfig(port?: string): Config {
	return {
		port: port || DEFAULT_PORT,
		betterAuthSecret: generateSecret(),
		encryptionKey: generateSecret(),
		internalApiSecret: generateSecret(),
		apiEncryptionKey: generateSecret(),
		disableAuth: true, // Single-user mode by default
		createdAt: new Date().toISOString(),
	}
}

/**
 * Check if Docker is running
 */
function isDockerRunning(): Promise<boolean> {
	return new Promise((resolve) => {
		const docker = spawn('docker', ['info'], { stdio: 'ignore' })
		docker.on('error', () => {
			resolve(false)
		})
		docker.on('close', (code) => {
			resolve(code === 0)
		})
	})
}

/**
 * Run a command and return success status
 */
async function runCommand(command: string[], silent = false): Promise<boolean> {
	return new Promise((resolve) => {
		const process = spawn(command[0], command.slice(1), {
			stdio: silent ? 'ignore' : 'inherit',
		})
		process.on('error', () => {
			resolve(false)
		})
		process.on('close', (code) => {
			resolve(code === 0)
		})
	})
}

/**
 * Ensure Docker network exists
 */
async function ensureNetworkExists(): Promise<boolean> {
	try {
		const networks = execSync('docker network ls --format "{{.Name}}"', {
			encoding: 'utf-8',
		})
		if (!networks.includes(NETWORK_NAME)) {
			console.log(chalk.blue(`🔄 Creating Docker network '${NETWORK_NAME}'...`))
			return await runCommand(['docker', 'network', 'create', NETWORK_NAME])
		}
		return true
	} catch (error) {
		return false
	}
}

/**
 * Pull Docker image
 */
async function pullImage(image: string): Promise<boolean> {
	console.log(chalk.blue(`🔄 Pulling ${image}...`))
	return await runCommand(['docker', 'pull', image])
}

/**
 * Stop and remove container
 */
async function stopAndRemoveContainer(name: string, silent = false): Promise<void> {
	try {
		execSync(`docker stop ${name} 2>/dev/null || true`, { stdio: silent ? 'ignore' : 'inherit' })
		execSync(`docker rm ${name} 2>/dev/null || true`, { stdio: silent ? 'ignore' : 'inherit' })
	} catch (_error) {
		// Ignore errors
	}
}

/**
 * Clean up existing containers
 */
async function cleanupExistingContainers(silent = false): Promise<void> {
	if (!silent) {
		console.log(chalk.blue('🧹 Cleaning up existing containers...'))
	}
	await stopAndRemoveContainer(APP_CONTAINER, silent)
	await stopAndRemoveContainer(REALTIME_CONTAINER, silent)
	await stopAndRemoveContainer(MIGRATIONS_CONTAINER, silent)
	await stopAndRemoveContainer(DB_CONTAINER, silent)
}

/**
 * Check if containers are running
 */
function isRunning(): boolean {
	try {
		const result = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf-8' })
		return result.includes(APP_CONTAINER)
	} catch {
		return false
	}
}

/**
 * Get container status
 */
function getContainerStatus(name: string): 'running' | 'stopped' | 'not found' {
	try {
		const result = execSync(`docker inspect -f '{{.State.Status}}' ${name} 2>/dev/null`, {
			encoding: 'utf-8',
		}).trim()
		return result === 'running' ? 'running' : 'stopped'
	} catch {
		return 'not found'
	}
}

/**
 * Wait for PostgreSQL to be ready
 */
async function waitForPostgres(): Promise<boolean> {
	console.log(chalk.blue('⏳ Waiting for PostgreSQL to be ready...'))
	for (let i = 0; i < 30; i++) {
		try {
			execSync(`docker exec ${DB_CONTAINER} pg_isready -U postgres 2>/dev/null`, {
				stdio: 'ignore',
			})
			return true
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 1000))
		}
	}
	return false
}

/**
 * Wait for app to be healthy
 */
async function waitForApp(port: string): Promise<boolean> {
	console.log(chalk.blue('⏳ Waiting for Sim to be ready...'))
	for (let i = 0; i < 60; i++) {
		try {
			execSync(`curl -s http://localhost:${port} > /dev/null 2>&1`, { stdio: 'ignore' })
			return true
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 1000))
		}
	}
	return false
}

/**
 * Open browser
 */
function openBrowser(url: string): void {
	try {
		const platform = process.platform
		if (platform === 'darwin') {
			execSync(`open ${url}`, { stdio: 'ignore' })
		} else if (platform === 'win32') {
			execSync(`start ${url}`, { stdio: 'ignore' })
		} else {
			execSync(`xdg-open ${url}`, { stdio: 'ignore' })
		}
	} catch {
		// Silently fail if browser can't be opened
	}
}

/**
 * Start Sim
 */
async function startSim(options: { port?: string; pull: boolean; open: boolean }): Promise<void> {
	console.log(chalk.blue.bold('🚀 Starting Sim...\n'))

	// Check if Docker is running
	const dockerRunning = await isDockerRunning()
	if (!dockerRunning) {
		console.error(chalk.red('❌ Docker is not running or not installed.'))
		console.log(chalk.yellow('\nPlease start Docker Desktop and try again.'))
		console.log(chalk.gray('   Download: https://www.docker.com/products/docker-desktop'))
		process.exit(1)
	}

	// Check if already running
	if (isRunning()) {
		const config = loadConfig()
		console.log(
			chalk.yellow(
				`⚠️  Sim is already running at ${chalk.bold(`http://localhost:${config.port}`)}`
			)
		)
		console.log(chalk.gray(`   Run ${chalk.bold('simstudio stop')} to stop it first.\n`))
		return
	}

	// Load or create config
	const config = loadConfig(options.port)

	// Pull latest images if requested
	if (options.pull) {
		const images = [
			'ghcr.io/simstudioai/simstudio:latest',
			'ghcr.io/simstudioai/migrations:latest',
			'ghcr.io/simstudioai/realtime:latest',
			'pgvector/pgvector:pg17',
		]

		for (const image of images) {
			const success = await pullImage(image)
			if (!success) {
				console.error(chalk.red(`❌ Failed to pull ${image}`))
				process.exit(1)
			}
		}
		console.log()
	}

	// Ensure network exists
	if (!(await ensureNetworkExists())) {
		console.error(chalk.red('❌ Failed to create Docker network'))
		process.exit(1)
	}

	// Clean up any existing containers
	await cleanupExistingContainers()

	// Create data directory
	if (!existsSync(DATA_DIR)) {
		mkdirSync(DATA_DIR, { recursive: true })
	}

	// Start PostgreSQL
	console.log(chalk.blue('🔄 Starting PostgreSQL database...'))
	const dbSuccess = await runCommand([
		'docker',
		'run',
		'-d',
		'--name',
		DB_CONTAINER,
		'--network',
		NETWORK_NAME,
		'-e',
		'POSTGRES_USER=postgres',
		'-e',
		'POSTGRES_PASSWORD=postgres',
		'-e',
		'POSTGRES_DB=simstudio',
		'-v',
		`${DATA_DIR}/postgres:/var/lib/postgresql/data`,
		'-p',
		'5432:5432',
		'pgvector/pgvector:pg17',
	])

	if (!dbSuccess) {
		console.error(chalk.red('❌ Failed to start PostgreSQL'))
		process.exit(1)
	}

	// Wait for PostgreSQL
	if (!(await waitForPostgres())) {
		console.error(chalk.red('❌ PostgreSQL failed to become ready'))
		process.exit(1)
	}

	// Run migrations
	console.log(chalk.blue('🔄 Running database migrations...'))
	const migrationsSuccess = await runCommand([
		'docker',
		'run',
		'--rm',
		'--name',
		MIGRATIONS_CONTAINER,
		'--network',
		NETWORK_NAME,
		'-e',
		`DATABASE_URL=postgresql://postgres:postgres@${DB_CONTAINER}:5432/simstudio`,
		'ghcr.io/simstudioai/migrations:latest',
		'bun',
		'run',
		'db:migrate',
	])

	if (!migrationsSuccess) {
		console.error(chalk.red('❌ Failed to run migrations'))
		process.exit(1)
	}

	// Start realtime server
	console.log(chalk.blue('🔄 Starting Realtime Server...'))
	const realtimeEnv = [
		'-e',
		`DATABASE_URL=postgresql://postgres:postgres@${DB_CONTAINER}:5432/simstudio`,
		'-e',
		`BETTER_AUTH_URL=http://localhost:${config.port}`,
		'-e',
		`NEXT_PUBLIC_APP_URL=http://localhost:${config.port}`,
		'-e',
		`BETTER_AUTH_SECRET=${config.betterAuthSecret}`,
	]

	if (config.disableAuth) {
		realtimeEnv.push('-e', 'DISABLE_AUTH=true')
	}

	const realtimeSuccess = await runCommand([
		'docker',
		'run',
		'-d',
		'--name',
		REALTIME_CONTAINER,
		'--network',
		NETWORK_NAME,
		'-p',
		'3002:3002',
		...realtimeEnv,
		'ghcr.io/simstudioai/realtime:latest',
	])

	if (!realtimeSuccess) {
		console.error(chalk.red('❌ Failed to start Realtime Server'))
		process.exit(1)
	}

	// Start main application
	console.log(chalk.blue('🔄 Starting Sim application...'))
	const appEnv = [
		'-e',
		`DATABASE_URL=postgresql://postgres:postgres@${DB_CONTAINER}:5432/simstudio`,
		'-e',
		`BETTER_AUTH_URL=http://localhost:${config.port}`,
		'-e',
		`NEXT_PUBLIC_APP_URL=http://localhost:${config.port}`,
		'-e',
		`NEXT_PUBLIC_SOCKET_URL=http://localhost:3002`,
		'-e',
		`BETTER_AUTH_SECRET=${config.betterAuthSecret}`,
		'-e',
		`ENCRYPTION_KEY=${config.encryptionKey}`,
		'-e',
		`INTERNAL_API_SECRET=${config.internalApiSecret}`,
		'-e',
		`API_ENCRYPTION_KEY=${config.apiEncryptionKey}`,
	]

	if (config.disableAuth) {
		appEnv.push('-e', 'DISABLE_AUTH=true')
	}

	const appSuccess = await runCommand([
		'docker',
		'run',
		'-d',
		'--name',
		APP_CONTAINER,
		'--network',
		NETWORK_NAME,
		'-p',
		`${config.port}:3000`,
		...appEnv,
		'ghcr.io/simstudioai/simstudio:latest',
	])

	if (!appSuccess) {
		console.error(chalk.red('❌ Failed to start Sim'))
		process.exit(1)
	}

	// Wait for app to be healthy
	const appReady = await waitForApp(config.port)

	console.log()
	console.log(chalk.green.bold('✅ Sim is now running!\n'))
	console.log(chalk.cyan(`   🌐 URL: ${chalk.bold(`http://localhost:${config.port}`)}`))
	if (config.disableAuth) {
		console.log(chalk.gray(`   🔓 Auth: Disabled (single-user mode)`))
	}
	console.log()
	console.log(chalk.gray(`   Run ${chalk.bold('simstudio stop')} to stop`))
	console.log(chalk.gray(`   Run ${chalk.bold('simstudio logs')} to view logs`))
	console.log()

	// Open browser if requested and app is ready
	if (options.open && appReady) {
		console.log(chalk.blue('🌐 Opening browser...\n'))
		openBrowser(`http://localhost:${config.port}`)
	}
}

/**
 * Stop Sim
 */
async function stopSim(): Promise<void> {
	console.log(chalk.blue('🛑 Stopping Sim...\n'))

	if (!isRunning()) {
		console.log(chalk.yellow('⚠️  Sim is not running'))
		return
	}

	await cleanupExistingContainers()

	console.log(chalk.green('✅ Sim stopped successfully\n'))
}

/**
 * Show logs
 */
async function showLogs(options: { follow: boolean; tail?: string }): Promise<void> {
	if (!isRunning()) {
		console.log(chalk.yellow('⚠️  Sim is not running'))
		console.log(chalk.gray(`   Run ${chalk.bold('simstudio start')} to start it\n`))
		return
	}

	const args = ['docker', 'logs', APP_CONTAINER]

	if (options.follow) {
		args.push('-f')
	}

	if (options.tail) {
		args.push('--tail', options.tail)
	}

	await runCommand(args)
}

/**
 * Show status
 */
function showStatus(): void {
	console.log(chalk.blue.bold('📊 Sim Status\n'))

	const containers = [
		{ name: APP_CONTAINER, label: 'Application' },
		{ name: REALTIME_CONTAINER, label: 'Realtime' },
		{ name: DB_CONTAINER, label: 'Database' },
	]

	for (const container of containers) {
		const status = getContainerStatus(container.name)
		const icon = status === 'running' ? '🟢' : status === 'stopped' ? '🟡' : '⚫'
		const color = status === 'running' ? chalk.green : status === 'stopped' ? chalk.yellow : chalk.gray
		console.log(`   ${icon} ${container.label.padEnd(15)} ${color(status)}`)
	}

	console.log()

	if (isRunning()) {
		const config = loadConfig()
		console.log(chalk.cyan(`   🌐 URL: ${chalk.bold(`http://localhost:${config.port}`)}\n`))
	} else {
		console.log(chalk.gray(`   Run ${chalk.bold('simstudio start')} to start Sim\n`))
	}
}

/**
 * Upgrade to latest version
 */
async function upgrade(): Promise<void> {
	console.log(chalk.blue.bold('⬆️  Upgrading Sim to latest version...\n'))

	const wasRunning = isRunning()
	let config: Config | undefined

	if (wasRunning) {
		config = loadConfig()
		console.log(chalk.yellow('🛑 Stopping running instance...\n'))
		await stopSim()
	}

	// Pull latest images
	const images = [
		'ghcr.io/simstudioai/simstudio:latest',
		'ghcr.io/simstudioai/migrations:latest',
		'ghcr.io/simstudioai/realtime:latest',
		'pgvector/pgvector:pg17',
	]

	for (const image of images) {
		const success = await pullImage(image)
		if (!success) {
			console.error(chalk.red(`❌ Failed to pull ${image}`))
			process.exit(1)
		}
	}

	console.log()
	console.log(chalk.green('✅ Upgrade complete!\n'))

	if (wasRunning && config) {
		console.log(chalk.blue('🚀 Restarting Sim...\n'))
		await startSim({ port: config.port, pull: false, open: false })
	}
}

/**
 * Reset Sim (delete all data)
 */
async function reset(options: { yes: boolean }): Promise<void> {
	console.log(chalk.red.bold('⚠️  Reset Sim\n'))
	console.log(chalk.yellow('This will delete all data including:'))
	console.log(chalk.yellow('  • All workflows'))
	console.log(chalk.yellow('  • Database'))
	console.log(chalk.yellow('  • Configuration\n'))

	if (!options.yes) {
		console.log(chalk.red('Use --yes flag to confirm reset'))
		console.log(chalk.gray(`   Example: ${chalk.bold('simstudio reset --yes')}\n`))
		return
	}

	// Stop if running
	if (isRunning()) {
		await stopSim()
	}

	// Remove data directory
	try {
		execSync(`rm -rf "${DATA_DIR}"`, { stdio: 'inherit' })
		execSync(`rm -f "${CONFIG_FILE}"`, { stdio: 'inherit' })
		console.log(chalk.green('✅ All data deleted\n'))
	} catch (error) {
		console.error(chalk.red('❌ Failed to delete data'))
		process.exit(1)
	}
}

/**
 * Show configuration
 */
function showConfig(): void {
	if (!existsSync(CONFIG_FILE)) {
		console.log(chalk.yellow('⚠️  No configuration found'))
		console.log(chalk.gray(`   Run ${chalk.bold('simstudio start')} to create one\n`))
		return
	}

	const config = loadConfig()

	console.log(chalk.blue.bold('⚙️  Configuration\n'))
	console.log(chalk.gray(`   Port:          ${config.port}`))
	console.log(chalk.gray(`   Single-User:   ${config.disableAuth ? 'enabled' : 'disabled'}`))
	console.log(chalk.gray(`   Config File:   ${CONFIG_FILE}`))
	console.log(chalk.gray(`   Data Dir:      ${DATA_DIR}`))
	console.log()
}

// CLI Program
const program = new Command()

program
	.name('simstudio')
	.description('Run Sim AI workflow platform')
	.version('0.2.0')

// Start command (default)
program
	.command('start', { isDefault: true })
	.description('Start Sim')
	.option('-p, --port <port>', 'Port to run on', DEFAULT_PORT)
	.option('--no-pull', 'Skip pulling latest images')
	.option('--no-open', 'Skip opening browser')
	.action(async (options) => {
		await startSim({ port: options.port, pull: options.pull, open: options.open })
	})

// Stop command
program
	.command('stop')
	.description('Stop Sim')
	.action(async () => {
		await stopSim()
	})

// Status command
program
	.command('status')
	.description('Show status')
	.action(() => {
		showStatus()
	})

// Logs command
program
	.command('logs')
	.description('Show logs')
	.option('-f, --follow', 'Follow log output')
	.option('-n, --tail <lines>', 'Number of lines to show from the end', '100')
	.action(async (options) => {
		await showLogs(options)
	})

// Upgrade command
program
	.command('upgrade')
	.description('Upgrade to latest version')
	.action(async () => {
		await upgrade()
	})

// Reset command
program
	.command('reset')
	.description('Delete all data and reset')
	.option('--yes', 'Confirm reset')
	.action(async (options) => {
		await reset(options)
	})

// Config command
program
	.command('config')
	.description('Show configuration')
	.action(() => {
		showConfig()
	})

// Parse arguments
program.parse()
