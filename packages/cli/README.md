# Sim CLI

Run [Sim](https://sim.ai) with a single command. No configuration needed.

## Quick Start

### Run without installing

```bash
npx simstudio
```

That's it! Sim will start at `http://localhost:2222`

### Or install globally

```bash
npm install -g simstudio
simstudio
```

## What it does

On first run, the CLI will:

1. ✅ Auto-generate secure secrets
2. ✅ Pull Docker images
3. ✅ Start PostgreSQL with pgvector
4. ✅ Run database migrations
5. ✅ Start the app in single-user mode (no auth required)
6. ✅ Open your browser automatically

## Commands

### `simstudio` or `simstudio start`

Start Sim (default command)

```bash
# Start on default port (2222)
simstudio

# Start on custom port
simstudio start -p 3000

# Skip pulling latest images
simstudio start --no-pull

# Skip opening browser
simstudio start --no-open
```

### `simstudio stop`

Stop all running containers

```bash
simstudio stop
```

### `simstudio status`

Show status of all containers

```bash
simstudio status
```

### `simstudio logs`

View application logs

```bash
# Show last 100 lines
simstudio logs

# Follow logs in real-time
simstudio logs -f

# Show last 500 lines
simstudio logs -n 500
```

### `simstudio upgrade`

Upgrade to latest version

```bash
simstudio upgrade
```

Automatically stops Sim, pulls latest images, and restarts.

### `simstudio config`

Show current configuration

```bash
simstudio config
```

### `simstudio reset`

Delete all data and reset to factory defaults

```bash
simstudio reset --yes
```

**Warning:** This deletes all workflows and data permanently.

## Configuration

Configuration is stored in `~/.simstudio/config.json`

- Secrets are auto-generated on first run
- Single-user mode enabled by default (no login required)
- Data stored in `~/.simstudio/data/`

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop) must be installed and running
- Node.js 16+ (for running the CLI)

## Troubleshooting

### Docker not running

```
❌ Docker is not running or not installed.
```

**Solution:** Start Docker Desktop and try again.

### Port already in use

```bash
# Use a different port
simstudio start -p 3000
```

### Reset everything

```bash
simstudio stop
simstudio reset --yes
simstudio start
```

## Advanced Usage

### Single-user vs Multi-user Mode

By default, the CLI runs in **single-user mode** (no authentication required).

To enable multi-user mode with authentication:

1. Edit `~/.simstudio/config.json`
2. Set `"disableAuth": false`
3. Restart: `simstudio stop && simstudio start`

### Data Persistence

All data is stored in `~/.simstudio/data/postgres/`

To backup your workflows:

```bash
# Backup
cp -r ~/.simstudio/data ~/sim-backup

# Restore
simstudio stop
rm -rf ~/.simstudio/data
cp -r ~/sim-backup ~/.simstudio/data
simstudio start
```

## Contributing

Contributions welcome! Please open an issue or submit a pull request.

## License

Apache-2.0
