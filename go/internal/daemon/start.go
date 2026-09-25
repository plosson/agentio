package daemon

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/vault"
)

// booting holds the first keepalive pass until the start lines are out: Bun
// schedules it with setTimeout(0), which runs only once startDaemon returns.
var booting sync.RWMutex

func waitForBoot() {
	booting.RLock()
	booting.RUnlock()
}

// signalNames are the signals Bun's daemon stops on, as it prints them.
var signalNames = map[os.Signal]string{os.Interrupt: "SIGINT", syscall.SIGTERM: "SIGTERM"}

// Run is Bun's startDaemon: it serves in the foreground, logs to stdout, and
// on SIGINT or SIGTERM stops the keepalive and the server and returns nil.
//
// The daemon never reads the passphrase file. It starts locked unless
// AGENTIO_PASSPHRASE is set, in which case the passphrase is verified before
// the server comes up and then dropped from the environment, so the resident
// copy is the single source of lock state.
func Run(reg *plugins.Registry, version string) error {
	say(fmt.Sprintf("agentio-daemon starting (PID %d)", os.Getpid()))
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	booting.Lock()
	var bootOnce sync.Once
	booted := func() { bootOnce.Do(booting.Unlock) }
	defer booted()

	vault.SetMemoryOnly(true)
	if pw := os.Getenv("AGENTIO_PASSPHRASE"); pw != "" {
		if err := vault.Unlock(pw); err != nil {
			return err
		}
		os.Unsetenv("AGENTIO_PASSPHRASE")
		say("Vault unlocked from AGENTIO_PASSPHRASE")
		KeepaliveFromEnv(rContext(), reg)
	} else {
		// Nothing to refresh while locked; unlocking at /ui starts the loop.
		say("Vault is locked")
	}

	ln, err := net.Listen("tcp", net.JoinHostPort(Host, strconv.Itoa(Port)))
	if err != nil {
		StopKeepalive()
		if errors.Is(err, syscall.EADDRINUSE) {
			return fmt.Errorf("Failed to start server. Is port %d in use?", Port)
		}
		return err
	}
	srv := &http.Server{Handler: (&Server{Registry: reg, Version: version}).Handler()}
	say(fmt.Sprintf("Daemon API listening on %s:%d", Host, Port))
	say(fmt.Sprintf("Admin UI at http://127.0.0.1:%d/ui", Port))
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	say("Daemon ready")
	booted()

	select {
	case sig := <-signals:
		say("\nReceived " + signalNames[sig] + ", shutting down...")
		StopKeepalive()
		_ = srv.Close()
		say("Daemon stopped")
		return nil
	case err := <-served:
		StopKeepalive()
		return err
	}
}
