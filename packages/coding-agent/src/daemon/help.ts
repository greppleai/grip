import { APP_NAME } from "../config.ts";

export function printDaemonHelp(write: (message: string) => void = console.log): void {
	write(`${APP_NAME} --daemon - remote workspace runtime

Usage:
  ${APP_NAME} --daemon [options]

Options:
  --daemon-host <ip>                    Bind IP (default: 127.0.0.1)
  --daemon-port <port>                  Bind port (default: 8787)
  --daemon-cwd <directory>              Confined workspace root (default: current directory)
  --daemon-origin <origin>              Allow an exact browser Origin (repeatable)
  --daemon-tls-cert <file>              Native TLS certificate
  --daemon-tls-key <file>               Native TLS private key
  --daemon-allow-insecure-transport     Acknowledge non-loopback transport without native TLS
  --daemon-allow-process-exec           Enable the unsafe process-execution capability
  --daemon-allow-root                   Allow running as root inside an intentional OS sandbox
  --daemon-env <NAME>                   Forward an approved environment name (repeatable)
  --daemon-lsp-config <file>            Operator-owned daemon LSP configuration
  --daemon-trust-project-lsp            Trust the confined project LSP layer
  --daemon-max-connections <count>      Maximum authenticated clients
  --daemon-max-pending-connections <n>  Maximum incomplete HTTP/WebSocket handshakes
  --daemon-handshake-timeout-ms <ms>    Protocol handshake deadline
  --daemon-shutdown-timeout-ms <ms>     Graceful shutdown deadline
  --help, -h                            Show daemon help

Environment:
  GRIP_DAEMON_HOST, GRIP_DAEMON_PORT, GRIP_DAEMON_CWD
  GRIP_DAEMON_TEMP_ROOT                   Optional additional confined temporary directory
  GRIP_DAEMON_TOKEN                     Server bearer token (32-1024 UTF-8 bytes)
  GRIP_DAEMON_ORIGINS                   Comma-separated exact browser origins
  GRIP_DAEMON_TLS_CERT, GRIP_DAEMON_TLS_KEY, GRIP_DAEMON_TLS_PASSPHRASE
  GRIP_DAEMON_ALLOW_INSECURE_TRANSPORT, GRIP_DAEMON_ALLOW_PROCESS_EXEC, GRIP_DAEMON_ALLOW_ROOT
  GRIP_DAEMON_ENV, GRIP_DAEMON_LSP_CONFIG, GRIP_DAEMON_TRUST_PROJECT_LSP
  GRIP_DAEMON_MAX_CONNECTIONS, GRIP_DAEMON_MAX_PENDING_CONNECTIONS
  GRIP_DAEMON_HANDSHAKE_TIMEOUT_MS, GRIP_DAEMON_SHUTDOWN_TIMEOUT_MS

Security:
  Non-loopback binds require GRIP_DAEMON_TOKEN and TLS unless insecure transport is explicitly acknowledged.
  Process execution is an RCE capability and requires OS-level isolation.`);
}
