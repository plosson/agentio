package daemon

import (
        "context"
        "encoding/json"
        "fmt"
        "net/http"
        "os"
        "os/signal"
        "syscall"
        "time"

        "github.com/plosson/agentio/go/internal/vault"
)

const (
        Host = "0.0.0.0"
        Port = 7890
)

type HealthResponse struct {
        Status    string `json:"status"`
        Timestamp int64  `json:"timestamp"`
        Uptime    int64  `json:"uptime"`
        Locked    bool   `json:"locked"`
}

// Start runs the daemon HTTP server (foreground). Unlocks vault when
// AGENTIO_PASSPHRASE is set. Skeleton: /health only (full v1 API later).
func Start(ctx context.Context, version string) error {
        started := time.Now()
        var store *vault.Store
        locked := true
        if pw := os.Getenv("AGENTIO_PASSPHRASE"); pw != "" {
                s, err := vault.Open(pw)
                if err != nil {
                        return fmt.Errorf("unlock vault: %w", err)
                }
                store = s
                locked = false
                _ = store
                fmt.Println("Vault unlocked from AGENTIO_PASSPHRASE")
        } else {
                fmt.Println("Vault is locked")
        }

        mux := http.NewServeMux()
        mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
                if r.Method != http.MethodGet {
                        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
                        return
                }
                resp := HealthResponse{
                        Status:    "ok",
                        Timestamp: time.Now().UnixMilli(),
                        Uptime:    time.Since(started).Milliseconds(),
                        Locked:    locked,
                }
                w.Header().Set("Content-Type", "application/json")
                _ = json.NewEncoder(w).Encode(resp)
        })

        addr := fmt.Sprintf("%s:%d", Host, Port)
        srv := &http.Server{Addr: addr, Handler: mux}
        fmt.Printf("agentio-daemon starting (Go skeleton %s)\n", version)
        fmt.Printf("Daemon API listening on %s\n", addr)
        fmt.Println("Daemon ready")

        errCh := make(chan error, 1)
        go func() { errCh <- srv.ListenAndServe() }()

        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

        select {
        case <-ctx.Done():
                _ = srv.Shutdown(context.Background())
                return ctx.Err()
        case sig := <-sigCh:
                fmt.Printf("\nReceived %s, shutting down...\n", sig)
                _ = srv.Shutdown(context.Background())
                fmt.Println("Daemon stopped")
                return nil
        case err := <-errCh:
                if err == http.ErrServerClosed {
                        return nil
                }
                return err
        }
}
